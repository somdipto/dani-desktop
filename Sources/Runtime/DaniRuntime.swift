import Foundation

// DANI RUNTIME CONTRACT
// ---------------------
// The only layer that understands OMP protocol details. The rest of the app
// (AppDelegate, UI) sees clean Swift events via `DaniRun`. OMP JSON never
// escapes this module.
//
// Conceptually (per spec):
//
//   protocol DaniRuntime {
//       func start() async throws
//       func stop() async
//       func prompt(_ text: String) async throws -> DaniRun
//       func abort() async
//       func state() async throws -> DaniState
//   }
//
// The desktop app owns ONE persistent OMP process (started in `start()`,
// stopped in `stop()`). `prompt(_:)` does NOT spawn a process — it sends a
// command on the already-started process and returns a `DaniRun` whose
// `AsyncSequence` of events completes when the AGENT finishes, not when the
// prompt is acknowledged.
//
// See `OmpRpcRuntime` for the implementation against the OMP RPC protocol
// (newline-delimited JSON over stdio; ready frame; `agent_end` with
// `isTerminal != false` is the completion signal).

// MARK: - DaniState

/// DANI Desktop's single authoritative UI state. No parallel booleans
/// (`isRecording` / `isProcessing` / `isAgentBusy` / `isWaiting` /
/// `isSpeaking` / `hasFinished` are all forbidden — the spec is explicit).
///
/// Transitions:
///
///   idle         --Fn down-->          listening
///   listening    --Fn up-->            transcribing
///   transcribing --transcript ready--> thinking
///   thinking     --OMP tool exec-->    working
///   working      --agent reasons-->   thinking
///   *            --OMP approval-->    needsUser
///   *            --agent_end-->       done
///   done         --short delay-->     idle
///   *            --failure-->         error
public enum DaniState: Equatable, Sendable {
    case idle
    case listening
    case transcribing
    case thinking
    case working
    case needsUser
    case done
    case error
}

// MARK: - DaniRunEvent

/// One streaming event from a `DaniRun`. The run completes when the AGENT
/// finishes — `.completed` or `.failed` are terminal.
public enum DaniRunEvent: Sendable, Equatable {
    /// OMP accepted the prompt and started an agent turn (`agent_start`).
    case started
    /// Streaming assistant text delta (`message_update` with
    /// `assistantMessageEvent.type == "text_delta"`).
    case textDelta(String)
    /// OMP began executing a tool (`tool_execution_start`).
    case toolStarted(name: String)
    /// OMP finished executing a tool (`tool_execution_end`).
    case toolFinished(name: String)
    /// OMP asked the host to confirm a consequential action
    /// (`extension_ui_request` with `method == "confirm"`). The UI shows
    /// "Send this email?" / "Delete this file?" and calls
    /// `DaniRuntime.approve(requestId:approved:)`.
    case needsApproval(requestId: String, prompt: String)
    /// The agent run finished cleanly. `agent_end` with `isTerminal != false`.
    /// Carries the final assistant text if OMP produced one.
    case completed(String?)
    /// The run failed (process error, RPC failure, or aborted).
    case failed(String)
}

// MARK: - DaniRun

/// One streaming run of `DaniRuntime.prompt(_:)`. Iterate its events with
/// `for try await event in run { ... }`. The sequence ends when the run
/// completes (`.completed`) or fails (`.failed`).
///
/// If the caller cancels the iterating `Task`, `onCallerCancelled` fires so
/// the runtime can send `abort` to OMP — no orphan agent turns.
public final class DaniRun: @unchecked Sendable, AsyncSequence {
    public typealias Element = DaniRunEvent
    public typealias AsyncIterator = AsyncStream<DaniRunEvent>.Iterator

    /// The RPC id used to correlate the prompt command with its response.
    public let id: String
    /// The prompt text this run was started with.
    public let prompt: String

    private let stream: AsyncStream<DaniRunEvent>
    fileprivate let continuation: AsyncStream<DaniRunEvent>.Continuation

    init(id: String, prompt: String, onCallerCancelled: @escaping () -> Void) {
        self.id = id
        self.prompt = prompt
        var cont: AsyncStream<DaniRunEvent>.Continuation!
        self.stream = AsyncStream { c in
            cont = c
            c.onTermination = { _ in onCallerCancelled() }
        }
        self.contuation = cont
    }

    public func makeAsyncIterator() -> AsyncIterator {
        stream.makeAsyncIterator()
    }

    /// Push an event to the stream. Terminal events (`.completed`, `.failed`)
    /// finish the stream — the caller's `for await` loop ends.
    ///
    /// `internal` (not `public`) so only the `Dani` module's runtime impl
    /// (`OmpRpcRuntime`) can produce events — the app's UI and AppDelegate
    /// consume events via the `AsyncSequence`, never emit.
    func emit(_ event: DaniRunEvent) {
        continuation.yield(event)
        switch event {
        case .completed, .failed:
            continuation.finish()
        default:
            break
        }
    }
}

// MARK: - DaniRuntimeError

public enum DaniRuntimeError: Error, Equatable {
    case binaryNotFound
    case startupTimeout
    case malformedRpc(String)
    case processExitedUnexpectedly(code: Int32?)
    case notStarted
    case alreadyRunning
    case restartExhausted(reason: String)
}

// MARK: - DaniRuntime

/// The runtime contract. Implementations (e.g. `OmpRpcRuntime`) own the
/// agent harness; the desktop app is just an input/output/permissions/UI/
/// process-host shell around it.
public protocol DaniRuntime: AnyObject {
    /// Start the persistent agent process. Throws `binaryNotFound` if the
    /// executable can't be located, `startupTimeout` if the ready frame
    /// doesn't arrive in time, `malformedRpc` if the ready frame is unusable.
    func start() async throws

    /// Gracefully stop the persistent process. Safe to call multiple times.
    func stop() async

    /// Send a prompt to the agent. Does NOT spawn a process — uses the one
    /// `start()` opened. Returns a `DaniRun` whose events stream until the
    /// agent finishes. Throws `notStarted` if `start()` wasn't called or the
    /// process is in a fatal state.
    func prompt(_ text: String) async throws -> DaniRun

    /// Abort the current run (sends `abort` to OMP). The current `DaniRun`
    /// emits `.failed("aborted")` and finishes.
    func abort() async

    /// Approve or reject a pending `needsApproval` request from OMP.
    func approve(requestId: String, approved: Bool) async

    /// Current runtime state. Mostly for Settings/diagnostics — the UI
    /// observes events via `DaniRun` for live updates.
    func state() async throws -> DaniState
}
