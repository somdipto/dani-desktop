import AppKit
import Speech
import Dani

/// DANI Desktop app orchestrator.
///
/// The desktop app is a peripheral. It hears (Fn + voice), shows (overlay +
/// status bar), and — once the runtime is wired — hosts one persistent OMP
/// process. It does NOT plan, reason, select tools, or remember context.
/// OMP owns all of that.
///
/// State machine (single source of truth — no parallel booleans):
///
///   idle
///     ↓ Fn down
///   recording
///     ↓ Fn up
///   armedToStop (trailing audio buffer)
///     ↓ buffer expires
///   transcribing
///     ↓ SpeechTranscriber.onTerminated(.final)
///   idle (transcript delivered to the runtime — wired in a later commit)
///
/// The DaniRuntime prompt path replaces Scribe's polish+paste in a later
/// commit. Until then, `deliverFinal` logs the transcript and returns to
/// idle — this is the spec's "removed ONLY the text-paste destination" state.
@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    public override init() { super.init() }

    private var statusItem: NSStatusItem!
    private let keyMonitor = FnKeyMonitor()
    private lazy var overlayPanel = DaniOverlay()

    /// Single source of truth for the recording lifecycle. All transitions go
    /// through `fnDown`, `fnUp`, `handleTermination`, or `resetSession` — no
    /// flag juggling.
    private enum SessionState {
        case idle
        case recording(session: SpeechTranscriber)
        case armedToStop(session: SpeechTranscriber, work: DispatchWorkItem)
        case transcribing(session: SpeechTranscriber)
    }

    private var sessionState: SessionState = .idle
    private var isEnabled = true

    /// Trailing audio captured after FN release. Users often let go a beat
    /// before they finish their sentence; this preserves those last words.
    private static let trailingBufferSeconds: TimeInterval = 0.5

    /// Per-frame delay for the menu-bar recording animation. 4 frames × 0.4s
    /// ≈ 1.6s loop — feels alive without buzzing.
    private static let recordingFrameInterval: TimeInterval = 0.4

    private var menubarIdleImage: NSImage?
    private var menubarRecordingFrames: [NSImage] = []
    private var recordingAnimationTimer: Timer?
    private var recordingFrameIndex = 0

    private var enableMenuItem: NSMenuItem!
    private var langMenuItem: NSMenuItem!
    private var systemDefaultLangItem: NSMenuItem!
    private var micMenuItem: NSMenuItem!
    private var micSubmenu: NSMenu!
    private var quitMenuItem: NSMenuItem!
    private var languageItems: [NSMenuItem] = []

    private var selectedLocaleCode: String {
        get { UserDefaults.standard.string(forKey: "selectedLocaleCode") ?? "zh-CN" }
        set { UserDefaults.standard.set(newValue, forKey: "selectedLocaleCode") }
    }

    private var currentLocale: Locale {
        let code = selectedLocaleCode
        return code.isEmpty ? .current : Locale(identifier: code)
    }

    // MARK: - Lifecycle

    public func applicationDidFinishLaunching(_ notification: Notification) {
        L10n.setLanguage(localeCode: selectedLocaleCode)

        setupStatusBar()

        SpeechTranscriber.requestPermissions { [weak self] granted, errorMsg in
            if !granted, let msg = errorMsg {
                self?.showAlert(title: L10n.t("alert.permissionRequired"), message: msg)
            }
        }

        keyMonitor.onFnDown = { [weak self] in self?.fnDown() }
        keyMonitor.onFnUp = { [weak self] in self?.fnUp() }

        if !keyMonitor.start() {
            showAccessibilityAlert()
        }

        // Re-attempt the event tap when the app regains focus, so the user can
        // grant Accessibility in System Settings without having to relaunch.
        NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.isEnabled { _ = self.keyMonitor.start() }
            }
        }
    }

    public func applicationWillTerminate(_ notification: Notification) {
        keyMonitor.stop()
    }

    // MARK: - Key events

    private func fnDown() {
        // Re-pressing FN during the trailing-buffer window means the user
        // wasn't done — keep the same session running.
        if case let .armedToStop(session, work) = sessionState {
            work.cancel()
            sessionState = .recording(session: session)
            DaniTrace.fn("down (re-press — continuing session)")
            return
        }

        guard isEnabled, case .idle = sessionState else { return }

        let session = SpeechTranscriber(locale: currentLocale)
        session.onAudioLevel = { [weak self] level in
            self?.overlayPanel.updateAudioLevel(level)
        }
        session.onPartial = { [weak self] text in
            self?.overlayPanel.updatePartialTranscript(text)
        }
        session.onTerminated = { [weak self] reason in
            self?.handleTermination(reason)
        }

        sessionState = .recording(session: session)
        DaniTrace.fn("down")
        DaniTrace.audio("recording")
        updateStatusIcon()
        overlayPanel.show()
        NSSound(named: .init("Tink"))?.play()
        session.start()
    }

    private func fnUp() {
        guard case let .recording(session) = sessionState else { return }
        DaniTrace.fn("up")

        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            guard case let .armedToStop(session, _) = self.sessionState else { return }
            self.sessionState = .transcribing(session: session)
            self.updateStatusIcon()
            self.overlayPanel.showLoading()
            DaniTrace.stt("transcribing")
            session.stop()
        }
        sessionState = .armedToStop(session: session, work: work)
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.trailingBufferSeconds, execute: work)
    }

    // MARK: - Session termination

    private func handleTermination(_ reason: SpeechTranscriber.Termination) {
        switch reason {
        case .final(let text):
            // Move straight back to idle. The polish-era `.polishing` state is
            // gone — DANI's post-transcript path (DaniRuntime.prompt) is wired
            // in a later commit; until then the transcript is logged only.
            // This is the spec's "removed ONLY the text-paste destination"
            // milestone: Fn → record → transcribe → (no destination yet).
            sessionState = .idle
            updateStatusIcon()
            deliverFinal(text)
        case .cancelled:
            DaniTrace.stt("cancelled")
            sessionState = .idle
            updateStatusIcon()
            overlayPanel.dismiss()
        case .error(let message):
            DaniTrace.stt("error: \(message)")
            sessionState = .idle
            updateStatusIcon()
            overlayPanel.dismiss()
        }
    }

    /// Receives the final transcript. Scribe polished then pasted; DANI sends
    /// to OMP via `DaniRuntime.prompt(transcript)`. The runtime is added in a
    /// later commit — until then, log and dismiss so the overlay doesn't hang.
    private func deliverFinal(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            overlayPanel.dismiss()
            sessionState = .idle
            updateStatusIcon()
            return
        }
        DaniTrace.stt("\"\(trimmed)\"")
        DaniTrace.dani("transcript ready — no destination wired yet (OMP runtime added next)")
        // No paste, no polish, no OMP yet. Return to idle so the next Fn press
        // works. The OMP wiring replaces this no-op with DaniRuntime.prompt().
        overlayPanel.dismiss()
        sessionState = .idle
        updateStatusIcon()
    }

    private func resetSession() {
        switch sessionState {
        case .idle:
            return
        case .recording(let session), .transcribing(let session):
            session.cancel()
        case .armedToStop(let session, let work):
            work.cancel()
            session.cancel()
        }
        // session.cancel() triggers onTerminated → handleTermination,
        // which moves the state machine back to .idle and updates UI.
    }

    // MARK: - Status bar

    private func setupStatusBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        loadMenubarImages()
        updateStatusIcon()

        let menu = NSMenu()

        enableMenuItem = NSMenuItem(title: L10n.t("menu.enabled"), action: #selector(toggleEnabled), keyEquivalent: "")
        enableMenuItem.target = self
        enableMenuItem.state = .on
        menu.addItem(enableMenuItem)

        menu.addItem(.separator())

        // Language submenu — controls the SFSpeechRecognizer locale.
        langMenuItem = NSMenuItem(title: L10n.t("menu.language"), action: nil, keyEquivalent: "")
        let langMenu = NSMenu()
        // (display title, locale code, isSystemDefault)
        let languages: [(String, String, Bool)] = [
            (L10n.t("menu.systemDefault"), "",      true),
            ("English (US)",               "en-US", false),
            ("中文 (简体)",                "zh-CN", false),
            ("中文 (繁體)",                "zh-TW", false),
            ("日本語",                     "ja-JP", false),
            ("한국어",                     "ko-KR", false),
        ]
        for (name, code, isSystem) in languages {
            let item = NSMenuItem(title: name, action: #selector(changeLanguage(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = code
            item.state = code == selectedLocaleCode ? .on : .off
            languageItems.append(item)
            if isSystem { systemDefaultLangItem = item }
            langMenu.addItem(item)
        }
        langMenuItem.submenu = langMenu
        menu.addItem(langMenuItem)

        // Microphone submenu — chooses which input device the recognizer reads
        // from. Items are rebuilt on `menuNeedsUpdate(_:)` so freshly-plugged
        // devices appear without relaunch.
        micMenuItem = NSMenuItem(title: L10n.t("menu.microphone"), action: nil, keyEquivalent: "")
        micSubmenu = NSMenu(title: L10n.t("menu.microphone"))
        micSubmenu.delegate = self
        rebuildMicrophoneSubmenu()
        micMenuItem.submenu = micSubmenu
        menu.addItem(micMenuItem)

        menu.addItem(.separator())

        quitMenuItem = NSMenuItem(title: quitMenuItemTitle(), action: #selector(quit), keyEquivalent: "q")
        quitMenuItem.target = self
        menu.addItem(quitMenuItem)

        statusItem.menu = menu
    }

    /// Re-apply current localization to all static menu titles.
    private func relocalizeStaticMenu() {
        enableMenuItem?.title = L10n.t("menu.enabled")
        langMenuItem?.title = L10n.t("menu.language")
        micMenuItem?.title = L10n.t("menu.microphone")
        quitMenuItem?.title = quitMenuItemTitle()
        systemDefaultLangItem?.title = L10n.t("menu.systemDefault")
        rebuildMicrophoneSubmenu()
    }

    /// Title for the Quit menu item, with the bundle version appended in
    /// parens. Putting the version here instead of on the "Enabled" row
    /// avoids fighting AppKit's title / keyEquivalent column layout.
    private func quitMenuItemTitle() -> String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        return "\(L10n.t("menu.quit")) (v\(version))"
    }

    // MARK: - Microphone submenu

    private func rebuildMicrophoneSubmenu() {
        guard let micSubmenu else { return }
        micSubmenu.removeAllItems()
        let pref = VoiceCapture.shared.preference

        let autoItem = NSMenuItem(
            title: L10n.t("menu.mic.auto"),
            action: #selector(selectMicAuto),
            keyEquivalent: ""
        )
        autoItem.target = self
        autoItem.state = (pref == .auto) ? .on : .off
        micSubmenu.addItem(autoItem)

        let sysItem = NSMenuItem(
            title: L10n.t("menu.systemDefault"),
            action: #selector(selectMicSystemDefault),
            keyEquivalent: ""
        )
        sysItem.target = self
        sysItem.state = (pref == .systemDefault) ? .on : .off
        micSubmenu.addItem(sysItem)

        let devices = VoiceCapture.inputDevices()
        if !devices.isEmpty {
            micSubmenu.addItem(.separator())
            for device in devices {
                let item = NSMenuItem(
                    title: device.name,
                    action: #selector(selectMicSpecific(_:)),
                    keyEquivalent: ""
                )
                item.target = self
                item.representedObject = device.uid
                if case .specific(let uid) = pref, uid == device.uid {
                    item.state = .on
                }
                micSubmenu.addItem(item)
            }
        }
    }

    /// AppKit calls this right before the submenu is displayed. Re-enumerate
    /// devices so freshly-plugged hardware shows up without a relaunch.
    public func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === micSubmenu {
            rebuildMicrophoneSubmenu()
        }
    }

    private func updateStatusIcon() {
        guard let button = statusItem.button else { return }
        button.contentTintColor = nil  // always inherit menu-bar foreground
        button.title = ""

        switch sessionState {
        case .recording, .armedToStop:
            startRecordingAnimation()
        case .idle, .transcribing:
            stopRecordingAnimation()
            button.image = menubarIdleImage
        }
    }

    private func loadMenubarImages() {
        // NSImage(named:) finds @1x and @2x reps for files in the bundle's
        // Resources directory and combines them into one image. Falls back to
        // an SF Symbol if the bundled assets are missing — the app should
        // never end up with an invisible status item.
        let menubarIconSize = NSSize(width: 18, height: 18)

        let idle = NSImage(named: "MenubarIdle")
            ?? NSImage(systemSymbolName: "waveform", accessibilityDescription: "Voice Input")
        idle?.isTemplate = true
        idle?.size = menubarIconSize
        menubarIdleImage = idle

        menubarRecordingFrames = (1...4).compactMap { i in
            let img = NSImage(named: "MenubarRecording\(i)")
            img?.isTemplate = true
            img?.size = menubarIconSize
            return img
        }
    }

    private func startRecordingAnimation() {
        if recordingAnimationTimer != nil { return }
        guard !menubarRecordingFrames.isEmpty else {
            statusItem.button?.image = menubarIdleImage
            return
        }
        recordingFrameIndex = 0
        statusItem.button?.image = menubarRecordingFrames[0]
        let timer = Timer.scheduledTimer(
            timeInterval: Self.recordingFrameInterval,
            target: self,
            selector: #selector(advanceRecordingFrame),
            userInfo: nil,
            repeats: true
        )
        // Without .common mode, the animation freezes whenever the menu-bar
        // menu is open (NSMenu pushes the run loop into .eventTracking).
        RunLoop.main.add(timer, forMode: .common)
        recordingAnimationTimer = timer
    }

    private func stopRecordingAnimation() {
        recordingAnimationTimer?.invalidate()
        recordingAnimationTimer = nil
        recordingFrameIndex = 0
    }

    @objc private func advanceRecordingFrame() {
        guard !menubarRecordingFrames.isEmpty else { return }
        recordingFrameIndex = (recordingFrameIndex + 1) % menubarRecordingFrames.count
        statusItem.button?.image = menubarRecordingFrames[recordingFrameIndex]
    }

    // MARK: - Actions

    @objc private func toggleEnabled() {
        isEnabled.toggle()
        enableMenuItem.state = isEnabled ? .on : .off

        if isEnabled {
            if !keyMonitor.start() {
                showAccessibilityAlert()
            }
        } else {
            keyMonitor.stop()
            resetSession()
        }
    }

    @objc private func changeLanguage(_ sender: NSMenuItem) {
        guard let code = sender.representedObject as? String else { return }
        selectedLocaleCode = code

        for item in languageItems {
            item.state = (item.representedObject as? String) == code ? .on : .off
        }

        L10n.setLanguage(localeCode: code)
        relocalizeStaticMenu()

        let target = code.isEmpty ? Locale.current : Locale(identifier: code)
        if !SpeechTranscriber.isLocaleSupported(target) {
            showAlert(
                title: L10n.t("alert.languageUnavailable"),
                message: "Speech recognition is not supported for \(target.identifier). Confirm the language is downloaded in System Settings → General → Keyboard → Dictation."
            )
        }
    }

    @objc private func selectMicAuto() {
        VoiceCapture.shared.preference = .auto
        rebuildMicrophoneSubmenu()
    }

    @objc private func selectMicSystemDefault() {
        VoiceCapture.shared.preference = .systemDefault
        rebuildMicrophoneSubmenu()
    }

    @objc private func selectMicSpecific(_ sender: NSMenuItem) {
        guard let uid = sender.representedObject as? String else { return }
        VoiceCapture.shared.preference = .specific(uid: uid)
        rebuildMicrophoneSubmenu()
    }

    @objc private func quit() {
        keyMonitor.stop()
        NSApp.terminate(nil)
    }

    @objc internal func openSettings() {
        // The Settings window (executable picker + model display from OMP) is
        // added in a later commit. Until then this is a no-op stub so the
        // selector exists for any future menu item to target.
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Alerts

    private func showAccessibilityAlert() {
        let alert = NSAlert()
        alert.messageText = L10n.t("alert.accessibilityTitle")
        alert.informativeText = L10n.t("alert.accessibilityBody")
        alert.alertStyle = .warning
        alert.addButton(withTitle: L10n.t("alert.openSystemSettings"))
        alert.addButton(withTitle: L10n.t("alert.later"))

        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            NSWorkspace.shared.open(
                URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
            )
        }
    }

    private func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: L10n.t("alert.ok"))
        alert.runModal()
    }
}

// MARK: - DaniTrace

/// Concise per-layer trace so a failed run shows exactly where it stopped.
/// Matches the spec's logging contract: `[fn]`, `[audio]`, `[stt]`,
/// `[omp]`, `[dani]`. No secrets.
enum DaniTrace {
    static func fn(_ msg: String)        { log("[fn]",   msg) }
    static func audio(_ msg: String)     { log("[audio]",msg) }
    static func stt(_ msg: String)       { log("[stt]",  msg) }
    static func omp(_ msg: String)       { log("[omp]",  msg) }
    static func dani(_ msg: String)      { log("[dani]", msg) }

    private static func log(_ tag: String, _ msg: String) {
        NSLog("%@ %@", tag, msg)
    }
}
