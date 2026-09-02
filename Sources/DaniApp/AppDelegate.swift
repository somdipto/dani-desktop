import AppKit
import Speech
import Dani

/// DANI Desktop app orchestrator.
///
/// The desktop app is a peripheral. It hears (Fn + voice), shows (overlay +
/// status bar), and hosts one persistent OMP process. It does NOT plan,
/// reason, select tools, or remember context. OMP owns all of that.
///
/// ONE authoritative state — `daniState: DaniState`. No parallel booleans
/// (isRecording / isProcessing / isAgentBusy / isWaiting / isSpeaking /
/// hasFinished are all forbidden; the spec is explicit). The recording
/// session, the trailing-buffer timer, and the OMP run Task are RESOURCE
/// HANDLES stored separately — they're not state, they're the things the
/// state currently holds.
///
/// Transitions (all go through `transition(to:detail:)`):
///
///   idle         --Fn down-->           listening
///   listening    --Fn up + 0.5s trail--> transcribing
///   transcribing --transcript ready-->  thinking (prompt sent)
///   thinking     --tool exec-->         working
///   working      --tool done-->         thinking
///   *            --approval-->          needsUser
///   *            --agent_end terminal--> done
///   *            --failure-->           error
///   done         --1.5s-->              idle
///   error        --2.5s-->              idle
///   listening/transcribing --cancel-->  idle
@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    public override init() { super.init() }

    private var statusItem: NSStatusItem!
    private let keyMonitor = FnKeyMonitor()
    private lazy var overlayPanel = DaniOverlay()
    private var devPanel: DaniDevPanel?
    private var settingsWindow: SettingsWindow?

    /// The persistent OMP runtime. One process, owned by DANI Desktop.
    private let runtime: DaniRuntime = OmpRpcRuntime()

    // MARK: - Single authoritative state + resource handles

    /// The one state. Drives the menubar icon and the overlay. Anything that
    /// wants to know "what is DANI doing right now?" reads this.
    private var daniState: DaniState = .idle

    /// The active speech session. Non-nil during `.listening` / `.transcribing`,
    /// nil otherwise. A resource handle, NOT a state.
    private var currentSession: SpeechTranscriber?

    /// The trailing-buffer `DispatchWorkItem` armed on Fn up. Non-nil between
    /// Fn up and the 0.5s trail firing (or a re-press cancelling it). A
    /// resource handle, NOT a state.
    private var trailingWork: DispatchWorkItem?

    /// The Task driving the current OMP run. Non-nil during `.thinking` /
    /// `.working` / `.needsUser` / `.done` / `.error`. Held so `resetSession`
    /// can cancel it.
    private var runTask: Task<Void, Never>?

    private var isEnabled = true

    /// Trailing audio captured after FN release. Users often let go a beat
    /// before they finish their sentence; this preserves those last words.
    private static let trailingBufferSeconds: TimeInterval = 0.5
    /// Per-frame delay for the menu-bar recording animation. 4 × 0.4s ≈ 1.6s.
    private static let recordingFrameInterval: TimeInterval = 0.4
    /// How long the "Done ✓" / "Failed" pill stays up before collapsing.
    private static let doneDismissSeconds: TimeInterval = 1.5
    private static let errorDismissSeconds: TimeInterval = 2.5

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

        // Start the persistent OMP process. Best-effort: if the binary isn't
        // found, the app still runs (the dev panel surfaces the error on the
        // first submit). Milestone 1 verification happens through the dev
        // panel — this is the first thing that must work before voice.
        Task { [weak self] in
            do {
                try await self?.runtime.start()
                DaniTrace.dani("runtime started")
            } catch let DaniRuntimeError.binaryNotFound {
                DaniTrace.dani("runtime: binary not found (open dev panel to see alert)")
            } catch {
                DaniTrace.dani("runtime start failed: \(error)")
            }
        }

        // Re-attempt the event tap when the app regains focus, so the user
        // can grant Accessibility in System Settings without having to relaunch.
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
        // Graceful OMP stop: close stdin, OMP exits 0. Best-effort.
        Task { [weak self] in
            await self?.runtime.stop()
        }
    }

    // MARK: - State machine

    /// The single transition function. Sets `daniState`, updates the menubar
    /// icon, and (for non-idle/listening states) drives the overlay via
    /// `DaniStatus.presentation`. All state changes go through here — no
    /// direct `daniState = ...` assignments elsewhere.
    private func transition(to newState: DaniState, detail: String? = nil) {
        let old = daniState
        daniState = newState
        DaniTrace.dani("\(old) -> \(newState)" + (detail.map { " (\($0))" } ?? ""))
        updateStatusIcon()

        // The overlay is driven by DaniState except for `.idle` (dismiss) and
        // `.listening` (waveform + partial transcript, driven by the speech
        // callbacks directly).
        switch newState {
        case .idle:
            // Overlay dismissal is handled by the caller (cleanupSession /
            // cleanupRun) — transition(.idle) on its own doesn't dismiss, so
            // the caller controls the timing.
            break
        case .listening:
            // show() was called by fnDown; the waveform + partial-transcript
            // callbacks drive the rest. No status pill during listening.
            break
        case .transcribing, .thinking, .working, .needsUser, .done, .error:
            overlayPanel.showState(newState, detail: detail)
        }
    }

    // MARK: - Key events

    private func fnDown() {
        // Re-pressing FN during the trailing-buffer window means the user
        // wasn't done — cancel the trail, stay in `.listening`, keep the
        // same session running.
        if let work = trailingWork {
            work.cancel()
            trailingWork = nil
            DaniTrace.fn("down (re-press — continuing session)")
            return
        }

        guard isEnabled, daniState == .idle else { return }

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

        currentSession = session
        DaniTrace.fn("down")
        DaniTrace.audio("recording")
        transition(to: .listening)
        overlayPanel.show()
        NSSound(named: .init("Tink"))?.play()
        session.start()
    }

    private func fnUp() {
        guard daniState == .listening, let session = currentSession else { return }
        DaniTrace.fn("up")

        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            guard self.daniState == .listening, let s = self.currentSession else { return }
            self.transition(to: .transcribing)
            DaniTrace.stt("transcribing")
            s.stop()
        }
        trailingWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.trailingBufferSeconds, execute: work)
    }

    // MARK: - Session termination

    private func handleTermination(_ reason: SpeechTranscriber.Termination) {
        switch reason {
        case .final(let text):
            // Stay in `.transcribing` — `deliverFinal` transitions to
            // `.thinking` (prompt sent) and keeps the overlay up.
            deliverFinal(text)
        case .cancelled:
            DaniTrace.stt("cancelled")
            cleanupSession()
        case .error(let message):
            DaniTrace.stt("error: \(message)")
            transition(to: .error, detail: message)
            overlayPanel.showState(.error, detail: message)
            scheduleDismiss(Self.errorDismissSeconds)
        }
    }

    /// Receives the final transcript and routes it to OMP. Scribe polished
    /// then pasted; DANI sends the raw transcript to `DaniRuntime.prompt()`
    /// and drives the overlay from the streamed `DaniRunEvent`s.
    private func deliverFinal(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            cleanupSession()
            return
        }
        DaniTrace.stt("\"\(trimmed)\"")

        // Release the session; we're done with it. The trailing work, if any,
        // already fired (that's how we got here).
        currentSession = nil
        trailingWork?.cancel()
        trailingWork = nil

        // Brief `.transcribing` ("Understanding…") while the prompt is in
        // flight; runPrompt transitions to `.thinking` once OMP accepts.
        transition(to: .transcribing)
        DaniTrace.omp("prompt queued (voice)")

        runTask = Task { [weak self] in
            await self?.runPrompt(trimmed)
        }
    }

    /// Drive a voice prompt through the runtime and stream events to the
    /// overlay. Milestone 2 path:
    ///
    ///   Fn up → transcribe → DaniRuntime.prompt(transcript) →
    ///     streaming DaniRunEvent → overlay (Understanding… / Working… /
    ///     Done ✓)
    private func runPrompt(_ text: String) async {
        let run: DaniRun
        do {
            run = try await promptViaRuntime(text)
            DaniTrace.omp("prompt sent (voice)")
            transition(to: .thinking)
        } catch let DaniRuntimeError.binaryNotFound {
            transition(to: .error, detail: "OMP not found")
            scheduleDismiss(Self.errorDismissSeconds)
            return
        } catch {
            transition(to: .error, detail: "\(error)")
            scheduleDismiss(Self.errorDismissSeconds)
            return
        }

        do {
            for try await event in run {
                applyRunEvent(event)
            }
        } catch {
            transition(to: .error, detail: "\(error)")
            scheduleDismiss(Self.errorDismissSeconds)
        }
    }

    /// Map a `DaniRunEvent` to a `DaniState` transition + overlay update.
    /// textDelta is intentionally NOT surfaced — the spec: no raw agent logs /
    /// chain-of-thought in the UI for MVP.
    private func applyRunEvent(_ event: DaniRunEvent) {
        switch event {
        case .started:
            transition(to: .thinking)
        case .textDelta:
            break  // stay in .thinking; no raw agent text in the pill
        case .toolStarted(let name):
            transition(to: .working, detail: name)
        case .toolFinished:
            transition(to: .thinking)
        case .needsApproval(_, let prompt):
            transition(to: .needsUser, detail: prompt)
        case .completed:
            DaniTrace.dani("done")
            transition(to: .done)
            scheduleDismiss(Self.doneDismissSeconds)
        case .failed(let msg):
            DaniTrace.dani("failed: \(msg)")
            transition(to: .error, detail: msg)
            scheduleDismiss(Self.errorDismissSeconds)
        }
    }

    private func scheduleDismiss(_ delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.cleanupRun()
        }
    }

    /// End of the OMP run: dismiss the overlay, release the run, return to
    /// idle so the next Fn press works.
    private func cleanupRun() {
        runTask = nil
        overlayPanel.dismiss()
        transition(to: .idle)
    }

    /// Cancel an in-flight recording (session.cancel → handleTermination(.cancelled)
    /// would re-enter, but we short-circuit here for the explicit cancel path).
    private func cleanupSession() {
        currentSession?.cancel()
        currentSession = nil
        trailingWork?.cancel()
        trailingWork = nil
        overlayPanel.dismiss()
        transition(to: .idle)
    }

    /// Hard reset (used by toggleEnabled → off). Aborts the OMP run if active,
    /// cancels the session if recording.
    private func resetSession() {
        switch daniState {
        case .idle:
            return
        case .listening, .transcribing:
            cleanupSession()
        case .thinking, .working, .needsUser, .done, .error:
            // Abort the OMP run.
            runTask?.cancel()
            runTask = nil
            Task { [weak self] in await self?.runtime.abort() }
            overlayPanel.dismiss()
            transition(to: .idle)
        }
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

        // Microphone submenu.
        micMenuItem = NSMenuItem(title: L10n.t("menu.microphone"), action: nil, keyEquivalent: "")
        micSubmenu = NSMenu(title: L10n.t("menu.microphone"))
        micSubmenu.delegate = self
        rebuildMicrophoneSubmenu()
        micMenuItem.submenu = micSubmenu
        menu.addItem(micMenuItem)

        menu.addItem(.separator())

        // Developer affordance: Milestone 1 text-prompt panel. Kept so the
        // path Swift UI -> OmpRpcRuntime -> OMP -> model -> streaming response
        // -> Swift UI can be exercised without a mic.
        let devItem = NSMenuItem(title: "Developer Prompt…", action: #selector(openDevPanel), keyEquivalent: "d")
        devItem.target = self
        menu.addItem(devItem)

        let settingsItem = NSMenuItem(title: L10n.t("menu.settings"), action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)

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

    /// Title for the Quit menu item, with the bundle version appended.
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

    public func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === micSubmenu {
            rebuildMicrophoneSubmenu()
        }
    }

    private func updateStatusIcon() {
        guard let button = statusItem.button else { return }
        button.contentTintColor = nil
        button.title = ""

        // Only `.listening` animates the menubar icon (recording). Every other
        // state — including `.transcribing` / `.thinking` / `.working` — shows
        // the idle icon; the overlay carries the spinner.
        if daniState == .listening {
            startRecordingAnimation()
        } else {
            stopRecordingAnimation()
            button.image = menubarIdleImage
        }
    }

    private func loadMenubarImages() {
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
        if settingsWindow == nil {
            let window = SettingsWindow()
            window.onExecutableChosen = { [weak self] newPath in
                self?.restartRuntime(newPath: newPath)
            }
            settingsWindow = window
        }
        settingsWindow?.refresh()
        settingsWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Restart the OMP runtime after the user changed the executable path in
    /// Settings (or chose auto-discovery). The Settings window already
    /// persisted (or cleared) the path via `OmpBinaryDiscovery`; `start()`
    /// will pick it up.
    private func restartRuntime(newPath: String?) {
        settingsWindow?.setStatus("Restarting…")
        Task { [weak self] in
            guard let self else { return }
            await self.runtime.stop()
            do {
                try await self.runtime.start()
                let label: String
                if let newPath {
                    label = "Restarted with: \(newPath)"
                } else {
                    label = "Restarted (auto-discovery)"
                }
                self.settingsWindow?.setStatus(label)
                DaniTrace.dani("runtime restarted via Settings")
            } catch let DaniRuntimeError.binaryNotFound {
                self.settingsWindow?.setStatus(L10n.t("dani.settings.executable.none"))
            } catch {
                self.settingsWindow?.setStatus("Restart failed: \(error)")
            }
        }
    }

    // MARK: - Developer prompt panel (Milestone 1)

    @objc private func openDevPanel() {
        if devPanel == nil {
            let panel = DaniDevPanel()
            panel.onSubmit = { [weak self] text in
                guard let self else { return }
                Task { await self.submitPrompt(text) }
            }
            devPanel = panel
        }
        devPanel?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Drive a prompt through the runtime and stream the response back into
    /// the dev panel. The Milestone 1 path:
    ///
    ///   Swift UI (dev panel) → OmpRpcRuntime → OMP → model →
    ///     streaming DaniRunEvent → Swift UI (dev panel)
    ///
    /// Definition of success (per spec): 10 consecutive successful prompts of
    /// "Reply exactly DANI_OK" with the model replying DANI_OK.
    private func submitPrompt(_ text: String) async {
        guard let panel = devPanel else { return }
        panel.setStatus("Working…")
        panel.beginResponse()
        DaniTrace.dani("dev prompt: \(text)")

        let run: DaniRun
        do {
            run = try await promptViaRuntime(text)
        } catch let DaniRuntimeError.binaryNotFound {
            panel.setStatus("")
            panel.finishResponse()
            showAlert(
                title: L10n.t("alert.executableNotFoundTitle"),
                message: L10n.t("alert.executableNotFoundBody")
            )
            return
        } catch {
            panel.setStatus("Failed: \(error)")
            panel.finishResponse()
            DaniTrace.dani("dev prompt failed: \(error)")
            return
        }

        do {
            for try await event in run {
                switch event {
                case .started:
                    panel.setStatus("Working…")
                case .textDelta(let s):
                    panel.appendResponse(s)
                case .toolStarted(let name):
                    panel.setStatus("Working: \(name)…")
                case .toolFinished:
                    panel.setStatus("Working…")
                case .needsApproval(_, let prompt):
                    panel.setStatus("Approval needed: \(prompt)")
                case .completed(let finalText):
                    if let finalText, !finalText.isEmpty {
                        panel.appendResponse(finalText)
                    }
                    panel.setStatus("Done ✓")
                    DaniTrace.dani("dev prompt done")
                case .failed(let msg):
                    panel.setStatus("Failed: \(msg)")
                    DaniTrace.dani("dev prompt failed: \(msg)")
                }
            }
        } catch {
            panel.setStatus("Failed: \(error)")
            DaniTrace.dani("dev prompt stream error: \(error)")
        }
        panel.finishResponse()
    }

    /// Prompt the runtime; if it hasn't started yet (best-effort start may
    /// still be in flight, or it failed because the binary wasn't found at
    /// launch), start it and retry once. `binaryNotFound` propagates so the
    /// caller can show the picker alert.
    private func promptViaRuntime(_ text: String) async throws -> DaniRun {
        do {
            return try await runtime.prompt(text)
        } catch DaniRuntimeError.notStarted {
            try await runtime.start()
            return try await runtime.prompt(text)
        }
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
