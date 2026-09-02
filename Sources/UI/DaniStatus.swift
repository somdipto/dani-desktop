import AppKit
import Dani

// DANI STATUS — state -> presentation
// -----------------------------------
// Centralizes the DaniState -> user-facing presentation mapping so the
// overlay, the menubar, and any future surface (Settings, Dock badge) all
// agree. The spec: one authoritative state (DaniState), no parallel booleans
// (isRecording / isProcessing / isAgentBusy / isWaiting / isSpeaking /
// hasFinished are all forbidden).
//
// `Presentation` is intentionally tiny: a label, an optional detail line
// (tool name, error message, approval prompt), and three flags the overlay
// uses to pick its visual (spinner / done check / error). No new UI surface
// is added for MVP — the overlay reuses its existing capsule + transcript
// pill, driven by these values.

enum DaniStatus {
    struct Presentation: Equatable {
        let label: String
        /// Secondary line. For `.working` this is the tool name (e.g.
        /// "computer"); for `.error` the failure message; for `.needsUser`
        /// the approval prompt. nil when the state has no natural detail.
        let detail: String?
        let showsSpinner: Bool
        let isDone: Bool
        let isError: Bool
    }

    /// Map a `DaniState` to its user-facing presentation. `detail` overrides
    /// the default detail (e.g. a tool name for `.working`, an error message
    /// for `.error`, an approval prompt for `.needsUser`).
    static func presentation(for state: DaniState, detail: String? = nil) -> Presentation {
        switch state {
        case .idle:
            return Presentation(label: "", detail: nil, showsSpinner: false, isDone: false, isError: false)
        case .listening:
            // The overlay shows the waveform, not the label, while listening;
            // the label is empty so the transcript pill stays hidden.
            return Presentation(label: "", detail: nil, showsSpinner: false, isDone: false, isError: false)
        case .transcribing:
            return Presentation(label: L10n.t("dani.state.transcribing"), detail: nil, showsSpinner: true, isDone: false, isError: false)
        case .thinking:
            return Presentation(label: L10n.t("dani.state.thinking"), detail: nil, showsSpinner: true, isDone: false, isError: false)
        case .working:
            return Presentation(label: L10n.t("dani.state.working"), detail: detail, showsSpinner: true, isDone: false, isError: false)
        case .needsUser:
            return Presentation(label: L10n.t("dani.state.needsApproval"), detail: detail, showsSpinner: false, isDone: false, isError: false)
        case .done:
            return Presentation(label: L10n.t("dani.state.done"), detail: nil, showsSpinner: false, isDone: true, isError: false)
        case .error:
            return Presentation(label: L10n.t("dani.state.error"), detail: detail, showsSpinner: false, isDone: true, isError: true)
        }
    }
}
