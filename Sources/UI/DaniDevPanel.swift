import AppKit
import Dani

// DEVELOPER PROMPT PANEL (Milestone 1)
// -----------------------------------
// The spec's FIRST MILESTONE: "Add a simple developer text field. User types:
// 'Reply exactly DANI_OK'. Path: Swift UI → OmpRpcRuntime → OMP → model →
// streaming response → Swift UI. Definition of success: 10 consecutive
// successful prompts. DO NOT TOUCH VOICE UNTIL THIS WORKS."
//
// This panel is intentionally minimal — a text field, a Send button, a
// status line, and a read-only response area. It exists to verify the
// runtime path before voice is wired. Once voice + DaniStatus land, this
// panel stays as a developer affordance (kept out of the user-facing menu
// flow) but is not removed — it's the fastest way to exercise OMP without
// a mic.

@MainActor
final class DaniDevPanel: NSPanel {
    private let promptField = NSTextField()
    private let sendButton = NSButton()
    private let statusLabel = NSTextField(labelWithString: "")
    private let responseView = NSTextView()
    private let responseScroll = NSScrollView()

    /// Sync closure fired on Send (or Enter). The AppDelegate wires this to
    /// a `Task { try await runtime.prompt(text); for try await event ... }`.
    var onSubmit: ((String) -> Void)?

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 360),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        title = "Dani — Developer Prompt"
        isReleasedWhenClosed = false
        minSize = NSSize(width: 360, height: 240)
        setupUI()
        center()
    }

    private func setupUI() {
        guard let cv = contentView else { return }

        promptField.placeholderString = L10n.t("dani.prompt.placeholder")
        promptField.target = self
        promptField.action = #selector(send)
        promptField.bezelStyle = .roundedBezel

        sendButton.title = "Send"
        sendButton.bezelStyle = .rounded
        sendButton.keyEquivalent = "\r"
        sendButton.target = self
        sendButton.action = #selector(send)

        statusLabel.font = .systemFont(ofSize: 11, weight: .medium)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.stringValue = ""

        responseView.isEditable = false
        responseView.isSelectable = true
        responseView.drawsBackground = false
        responseView.font = .systemFont(ofSize: 12)
        responseView.textContainer?.lineBreakMode = .byWordWrapping
        responseView.textContainer?.widthTracksTextView = true
        responseView.autoresizingMask = [.width]

        responseScroll.documentView = responseView
        responseScroll.hasVerticalScroller = true
        responseScroll.drawsBackground = false
        responseScroll.borderType = .bezelBorder

        let promptRow = NSStackView(views: [promptField, sendButton])
        promptRow.orientation = .horizontal
        promptRow.alignment = .firstBaseline
        promptRow.spacing = 8

        let main = NSStackView(views: [promptRow, statusLabel, responseScroll])
        main.orientation = .vertical
        main.alignment = .leading
        main.spacing = 8
        main.translatesAutoresizingMaskIntoConstraints = false
        main.setHuggingPriority(.defaultLow, for: .horizontal)
        main.setHuggingPriority(.defaultLow, for: .vertical)

        cv.addSubview(main)

        NSLayoutConstraint.activate([
            main.topAnchor.constraint(equalTo: cv.topAnchor, constant: 12),
            main.leadingAnchor.constraint(equalTo: cv.leadingAnchor, constant: 12),
            main.trailingAnchor.constraint(equalTo: cv.trailingAnchor, constant: -12),
            main.bottomAnchor.constraint(equalTo: cv.bottomAnchor, constant: -12),

            // Give the response area the bulk of the vertical space.
            responseScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 160),
            promptRow.heightAnchor.constraint(equalToConstant: 22),
            statusLabel.heightAnchor.constraint(equalToConstant: 14),
        ])
    }

    // MARK: - Actions

    @objc private func send() {
        let text = promptField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        // Disable while in-flight so the user can't queue two prompts (OMP
        // runs one at a time; the runtime throws alreadyRunning anyway).
        promptField.isEnabled = false
        sendButton.isEnabled = false
        onSubmit?(text)
    }

    // MARK: - Public (called by AppDelegate on the main actor)

    func setStatus(_ text: String) {
        statusLabel.stringValue = text
    }

    func beginResponse() {
        responseView.string = ""
    }

    func appendResponse(_ text: String) {
        // Append to the end of the text view, scroll to bottom.
        let end = responseView.string.count
        responseView.replaceCharacters(in: NSRange(location: end, length: 0), with: text)
        responseView.scrollToEndOfDocument(nil)
    }

    func setResponse(_ text: String) {
        responseView.string = text
        responseView.scrollToEndOfDocument(nil)
    }

    func finishResponse() {
        promptField.isEnabled = true
        sendButton.isEnabled = true
        promptField.stringValue = ""
        promptField.window?.makeFirstResponder(promptField)
    }
}
