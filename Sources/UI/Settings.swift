import AppKit
import Dani

// DANI SETTINGS
// -------------
// Per spec, the PRIMARY Settings requirement is the executable picker:
// "Settings → Choose DANI executable. Once successfully resolved, persist
// the path." Model provider display is "eventually" and must come from OMP
// (not a second authoritative registry) — left as a TODO for post-MVP.
//
// The picker persists the chosen path via `OmpBinaryDiscovery.persist` and
// calls `onExecutableChosen`. The AppDelegate stops the runtime, swaps the
// persisted path, and starts it again so the change takes effect without a
// relaunch. Passing `nil` means "use auto-discovery" (clears the persisted
// path).

@MainActor
final class SettingsWindow: NSPanel {
    /// Fired when the user picks a new executable path (non-nil) or chooses
    /// auto-discovery (nil). The AppDelegate restarts the runtime with the
    /// new resolution.
    var onExecutableChosen: ((String?) -> Void)?

    private let pathLabel = NSTextField(labelWithString: "")
    private let statusLabel = NSTextField(labelWithString: "")
    private let chooseButton = NSButton()
    private let autoButton = NSButton()

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 200),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        title = L10n.t("dani.settings.title")
        isReleasedWhenClosed = false
        setupUI()
        refresh()
        center()
    }

    private func setupUI() {
        guard let cv = contentView else { return }

        let header = NSTextField(labelWithString: L10n.t("dani.settings.executable"))
        header.font = .boldSystemFont(ofSize: 12)

        pathLabel.font = .systemFont(ofSize: 11)
        pathLabel.textColor = .secondaryLabelColor
        pathLabel.lineBreakMode = .byTruncatingMiddle
        pathLabel.maximumNumberOfLines = 1
        pathLabel.cell?.truncatesLastVisibleLine = true

        statusLabel.font = .systemFont(ofSize: 11)
        statusLabel.textColor = .tertiaryLabelColor
        statusLabel.lineBreakMode = .byWordWrapping
        statusLabel.maximumNumberOfLines = 0
        statusLabel.preferredMaxLayoutWidth = 460

        chooseButton.title = L10n.t("dani.settings.executable.choose")
        chooseButton.bezelStyle = .rounded
        chooseButton.target = self
        chooseButton.action = #selector(chooseTapped)

        autoButton.title = "Auto-discover"
        autoButton.bezelStyle = .rounded
        autoButton.target = self
        autoButton.action = #selector(autoTapped)

        let buttonRow = NSStackView(views: [chooseButton, autoButton])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 8

        let doneButton = NSButton(title: L10n.t("dani.settings.done"), target: self, action: #selector(closeWindow))
        doneButton.bezelStyle = .rounded
        doneButton.keyEquivalent = "\r"

        let main = NSStackView(views: [header, pathLabel, buttonRow, statusLabel])
        main.orientation = .vertical
        main.alignment = .leading
        main.spacing = 10
        main.translatesAutoresizingMaskIntoConstraints = false

        let bottomBar = NSStackView(views: [doneButton])
        bottomBar.orientation = .horizontal
        bottomBar.translatesAutoresizingMaskIntoConstraints = false

        cv.addSubview(main)
        cv.addSubview(bottomBar)

        NSLayoutConstraint.activate([
            main.topAnchor.constraint(equalTo: cv.topAnchor, constant: 20),
            main.leadingAnchor.constraint(equalTo: cv.leadingAnchor, constant: 20),
            main.trailingAnchor.constraint(equalTo: cv.trailingAnchor, constant: -20),

            bottomBar.topAnchor.constraint(greaterThanOrEqualTo: main.bottomAnchor, constant: 16),
            bottomBar.bottomAnchor.constraint(equalTo: cv.bottomAnchor, constant: -16),
            bottomBar.trailingAnchor.constraint(equalTo: cv.trailingAnchor, constant: -20),
        ])
    }

    /// Re-read the persisted path + show it. Called on open and after a pick.
    func refresh() {
        if let p = OmpBinaryDiscovery.persisted {
            pathLabel.stringValue = p
        } else if let resolved = OmpBinaryDiscovery.resolve() {
            // Nothing persisted but auto-discovery found something — show it.
            pathLabel.stringValue = String(format: L10n.t("dani.settings.executable.discovered"), resolved)
        } else {
            pathLabel.stringValue = L10n.t("dani.settings.executable.none")
        }
        statusLabel.stringValue = ""  // Filled by AppDelegate via setStatus if needed.
    }

    func setStatus(_ text: String) {
        statusLabel.stringValue = text
    }

    // MARK: - Actions

    @objc private func chooseTapped() {
        let panel = NSOpenPanel()
        panel.title = "Choose DANI executable (omp or dani)"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = []  // any executable
        panel.directoryURL = URL(fileURLWithPath: "/opt/homebrew/bin")
        if panel.runModal() == .OK, let url = panel.url {
            OmpBinaryDiscovery.persist(url.path)
            refresh()
            onExecutableChosen?(url.path)
        }
    }

    @objc private func autoTapped() {
        OmpBinaryDiscovery.clearPersisted()
        refresh()
        onExecutableChosen?(nil)
    }

    @objc private func closeWindow() {
        close()
    }
}
