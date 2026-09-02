import AppKit
import AVFoundation
import Speech

// PERMISSION MANAGER
// ------------------
// Centralizes the three permissions DANI Desktop needs:
//   - Microphone (AVCaptureDevice.requestAccess for audio)
//   - Speech recognition (SFSpeechRecognizer.requestAuthorization)
//   - Accessibility (AXIsProcessTrusted — for the Fn key CGEventTap)
//
// Scribe handled these inline (SpeechTranscriber.requestPermissions +
// KeyMonitor.start's bool). DANI keeps Scribe's behavior but routes the
// checks through one place so the Settings UI and future surfaces
// (notifications, screen recording for OMP computer-use screenshots if
// that ever moves desktop-side) have a single entry point.
//
// The desktop app does NOT itself need screen-recording or Apple-Events
// permission for MVP: OMP owns computer-use and runs as a separate process
// with its own entitlements.

@MainActor
enum PermissionManager {
    /// Request microphone + speech-recognition authorization. `completion`
    /// fires on the main thread: `(granted, messageIfDenied)`.
    static func requestSpeechAndMic(_ completion: @escaping (_ granted: Bool, _ message: String?) -> Void) {
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                switch status {
                case .authorized:
                    AVCaptureDevice.requestAccess(for: .audio) { granted in
                        DispatchQueue.main.async {
                            if granted {
                                completion(true, nil)
                            } else {
                                completion(false, "Microphone access denied.\nGrant in System Settings → Privacy & Security → Microphone.")
                            }
                        }
                    }
                case .denied, .restricted:
                    completion(false, "Speech recognition denied.\nGrant in System Settings → Privacy & Security → Speech Recognition.")
                case .notDetermined:
                    completion(false, "Speech recognition permission not determined.")
                @unknown default:
                    completion(false, "Unknown speech recognition authorization status.")
                }
            }
        }
    }

    /// True if the app has Accessibility permission (needed for the Fn-key
    /// CGEventTap). The CGEventTap creation in `FnKeyMonitor.start()` fails
    /// when this is false; we check up front so the UI can prompt.
    static func accessibilityGranted() -> Bool {
        AXIsProcessTrusted()
    }

    /// Open System Settings → Privacy & Security → Accessibility.
    static func openAccessibilitySettings() {
        NSWorkspace.shared.open(
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        )
    }
}
