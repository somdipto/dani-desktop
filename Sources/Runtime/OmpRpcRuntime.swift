import Foundation
import os

// OMP RPC RUNTIME
// --------------
// `DaniRuntime` implementation backed by one persistent OMP child process.
//
//   start()  -> discover binary, spawn `omp --mode rpc`, wait for ready frame,
//               start the frame-reader task.
//   prompt() -> send `{ id, type: "prompt", message }`, return a `DaniRun`.
//   abort()  -> send `{ type: "abort" }`, fail the current run as "aborted".
//   approve()-> send `extension_ui_response` with `confirmed` or `cancelled`.
//   stop()   -> cancel reader, close stdin (OMP exits 0), wait, kill if needed.
//
// The reader task iterates `OmpRpcProcess.stream`, decodes each frame via
// `OmpEventDecoder`, and dispatches agent events to the current `DaniRun`.
// Completion is `agent_end` with `isTerminal != false` (the decoder enforces
// this — non-terminal `agent_end` is dropped, waiting for the real one).
//
// OMP JSON never escapes this file.

actor OmpRpcRuntime: DaniRuntime {
    /// Resolved on `start()`. Cleared on `stop()`. Re-resolved if the binary
    /// disappears (next `start()` re-discovers).
    private var process: OmpRpcProcess?

    /// The OMP-phase view of state (idle / thinking / working / needsUser /
    /// done / error). The AppDelegate holds the authoritative app-wide
    /// `DaniState` (which also covers listening / transcribing) and maps
    /// `DaniRunEvent`s into it as it iterates each run.
    private var runtimeState: DaniState = .idle

    /// The single active run. OMP doesn't multiplex prompts in MVP — one at a
    /// time. Concurrent `prompt()` calls throw `alreadyRunning`.
    private var currentRun: DaniRun?
    private var currentRunId: String?

    private var idCounter = 0
    private var readerTask: Task<Void, Never>?
    private var restartCount = 0
    private static let maxRestarts = 1

    init() {}

    // MARK: - DaniRuntime

    func start() async throws {
        guard process == nil else { throw DaniRuntimeError.alreadyRunning }

        guard let binaryPath = OmpBinaryDiscovery.resolve() else {
            runtimeState = .error
            throw DaniRuntimeError.binaryNotFound
        }

        let proc = OmpRpcProcess(binaryPath: binaryPath)
        do {
            try await proc.start()
        } catch {
            runtimeState = .error
            DaniTrace.omp("start failed: \(error)")
            throw error
        }

        self.process = proc
        self.runtimeState = .idle
        DaniTrace.omp("ready (binary=\(binaryPath))")

        // Start the frame reader. It runs for the lifetime of the process.
        readerTask = Task { [weak self] in
            await self?.readerLoop()
        }
    }

    func stop() async {
        readerTask?.cancel()
        readerTask = nil
        if let proc = process {
            await proc.stop()
        }
        // If a run is still active, fail it (the process is gone).
        if let run = currentRun {
            run.emit(.failed("runtime stopped"))
            currentRun = nil
            currentRunId = nil
        }
        process = nil
        runtimeState = .idle
    }

    func prompt(_ text: String) async throws -> DaniRun {
        guard let proc = process else { throw DaniRuntimeError.notStarted }
        guard currentRun == nil else { throw DaniRuntimeError.alreadyRunning }

        let id = "dani_\(idCounter)"
        idCounter &+= 1

        // If the caller cancels the iterating Task, send `abort` to OMP — no
        // orphan agent turns. The Task hop is required because `abort()` is
        // an actor method.
        let run = DaniRun(id: id, prompt: text) { [weak self] in
            guard let self else { return }
            Task { await self.abort() }
        }

        currentRun = run
        currentRunId = id
        runtimeState = .thinking

        let command: [String: Any] = [
            "id": id,
            "type": "prompt",
            "message": text,
        ]
        do {
            try await proc.send(command)
        } catch {
            currentRun = nil
            currentRunId = nil
            runtimeState = .error
            run.emit(.failed("prompt send failed: \(error)"))
            throw error
        }
        // The process just demonstrably worked — reset the bounded-restart
        // budget so a future death is treated as a fresh event, not a
        // continuation of an old one.
        restartCount = 0
        DaniTrace.omp("prompt sent (id=\(id))")
        return run
    }

    func abort() async {
        guard let proc = process, let run = currentRun else { return }
        // Best-effort: tell OMP to abort. Even if the send fails, fail the run
        // locally so the caller's iteration ends.
        try? await proc.send(["id": currentRunId ?? "", "type": "abort"])
        run.emit(.failed("aborted"))
        currentRun = nil
        currentRunId = nil
        runtimeState = .idle
    }

    func approve(requestId: String, approved: Bool) async {
        guard let proc = process else { return }
        // OMP extension_ui_response shape:
        //   { type: "extension_ui_response", id, confirmed: true }   (approve)
        //   { type: "extension_ui_response", id, cancelled: true }   (reject)
        let command: [String: Any] = approved
            ? ["type": "extension_ui_response", "id": requestId, "confirmed": true]
            : ["type": "extension_ui_response", "id": requestId, "cancelled": true]
        try? await proc.send(command)
        if approved {
            runtimeState = .thinking  // resume reasoning after approval
        } else {
            // Rejection aborts the run.
            if let run = currentRun {
                run.emit(.failed("approval rejected by user"))
            }
            currentRun = nil
            currentRunId = nil
            runtimeState = .idle
        }
    }

    func state() async throws -> DaniState {
        return runtimeState
    }

    // MARK: - Reader loop

    private func readerLoop() async {
        guard let proc = process else { return }
        do {
            for try await frame in proc.stream {
                let decoded = OmpEventDecoder.decode(json: frame)
                self.dispatch(decoded)
            }
        } catch {
            // Stream threw (shouldn't normally — AsyncThrowingStream only
            // throws if the producer signals an error; we only ever finish).
            DaniTrace.omp("stream error: \(error)")
        }

        // Stream ended (EOF = OMP closed stdout = process exited). If a run is
        // still active, it never reached agent_end — fail it.
        if let run = currentRun {
            DaniTrace.omp("process exited mid-run")
            run.emit(.failed("OMP process exited unexpectedly"))
            currentRun = nil
            currentRunId = nil
            runtimeState = .error
            // One bounded restart: try to bring the process back so the next
            // prompt can run. The restart itself doesn't re-issue the failed
            // prompt — that's the caller's decision.
            if restartCount < Self.maxRestarts {
                restartCount &+= 1
                DaniTrace.omp("restarting (attempt \(restartCount)/\(Self.maxRestarts))")
                try? await self.restart()
            }
        }
    }

    private func restart() async throws {
        if let proc = process { await proc.stop() }
        self.process = nil
        try await self.start()
    }

    // MARK: - Dispatch

    private func dispatch(_ frame: OmpDecodedFrame) {
        switch frame {
        case .ready:
            // The ready frame was consumed by OmpRpcProcess.start(). Receiving
            // another one is unusual but harmless.
            DaniTrace.omp("unexpected ready frame (ignored)")

        case let .responseAck(id, command, success, agentInvoked, error):
            switch command {
            case "prompt":
                if !success {
                    DaniTrace.omp("prompt failed: \(error ?? "?")")
                    emitToCurrentRun(.failed(error ?? "prompt rejected"))
                    runtimeState = .error
                    return
                }
                // agentInvoked == false  => local-only prompt (slash command),
                //                           the run is already done.
                // agentInvoked == true   => agent lifecycle events follow;
                //                           wait for agent_end.
                // agentInvoked == nil    => unknown; rely on agent_end /
                //                           prompt_result.
                if agentInvoked == false {
                    DaniTrace.omp("prompt ack (local-only) — completing")
                    emitToCurrentRun(.completed(nil))
                    runtimeState = .done
                } else {
                    DaniTrace.omp("prompt ack (agent invoked=\(agentInvoked.map(String.init(describing:)) ?? "nil"))")
                }
            default:
                // get_state / get_available_models / set_model etc. — handled
                // inline by Settings in a later commit via dedicated pending
                // request continuations. For MVP, log and drop.
                DaniTrace.omp("response: \(command) success=\(success)")
            }

        case let .promptResult(id, agentInvoked):
            if agentInvoked == false, id == currentRunId {
                DaniTrace.omp("prompt_result (local-only) — completing")
                emitToCurrentRun(.completed(nil))
                runtimeState = .done
            }

        case let .agentEvent(event):
            switch event {
            case .started:
                runtimeState = .thinking
                DaniTrace.omp("agent_start")
            case .textDelta:
                runtimeState = .thinking
            case .toolStarted(let name):
                runtimeState = .working
                DaniTrace.omp("tool_execution_start \(name)")
            case .toolFinished(let name):
                runtimeState = .thinking
                DaniTrace.omp("tool_execution_end \(name)")
            case .needsApproval(_, let prompt):
                runtimeState = .needsUser
                DaniTrace.omp("approval requested: \(prompt)")
            case .completed(let text):
                runtimeState = .done
                DaniTrace.omp("agent_end (\(text?.isEmpty == false ? "\(text!.count) chars" : "no text"))")
            case .failed(let msg):
                runtimeState = .error
                DaniTrace.omp("run failed: \(msg)")
            }
            emitToCurrentRun(event)

        case let .parseError(msg):
            DaniTrace.omp("parse error: \(msg)")

        case let .ignored(type):
            // Known but not handled for MVP. Debug-level only — the spec says
            // no raw agent logs in the UI, but a developer trace is fine.
            DaniTrace.omp("ignored: \(type)")
        }
    }

    private func emitToCurrentRun(_ event: DaniRunEvent) {
        // Terminal events (.completed/.failed) finish the run via DaniRun.emit.
        currentRun?.emit(event)
        if case .completed = event {
            currentRun = nil
            currentRunId = nil
        } else if case .failed = event {
            currentRun = nil
            currentRunId = nil
        }
    }
}
