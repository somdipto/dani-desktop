import Foundation
import os

// OMP RPC PROCESS
// ---------------
// Owns ONE persistent `omp --mode rpc` (or `dani --mode rpc`) child process.
// Newline-delimited JSON over stdio:
//   - stdin:  commands (one JSON object per line)
//   - stdout: ready frame, then responses + agent events (one JSON per line)
//   - stderr: captured for diagnostics
//
// Per OMP RPC docs (https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md):
//   - The first stdout frame is `{ "type": "ready", "protocolVersion": 1, ... }`.
//   - On stdin close, pending requests are rejected and the process exits 0.
//   - Malformed JSON on stdin emits a recoverable `command: "parse"` failure;
//     the loop does not terminate.
//
// MVP stays on protocol v1 (no `negotiate_protocol`): DANI prompts and text
// deltas are tiny; v2 chunk reassembly only matters for frames above 1 MiB.
//
// This actor is the only thing that touches the child process directly.
// `OmpRpcRuntime` sits on top and adds request/response correlation +
// `DaniRun` event mapping.

/// One persistent OMP child process.
actor OmpRpcProcess {
    /// Path to the `omp` / `dani` binary. Resolved once by `OmpBinaryDiscovery`
    /// and passed in; the runtime re-resolves on `binaryNotFound`.
    let binaryPath: String

    /// Ready-frame wait. Set by `start()`; resumed by the first stdout frame
    /// (which must be the ready frame) or by the startup-timeout task.
    private let readyContBox = Mutex<CheckedContinuation<[String: Any], Error>?>(nil)

    /// Incoming-frames stream continuation. Set in init; yielded to by the
    /// stdout readability handler (off-actor). The runtime iterates the stream.
    private let incomingContBox = Mutex<AsyncThrowingStream<[String: Any], Error>.Continuation?>(nil)

    /// Stderr buffer, accumulated off-actor via the stderr readability handler.
    private let stderrBuffer = Mutex<Data>(Data())

    /// The stream of parsed JSON frames (everything after the ready frame).
    /// The runtime iterates this to dispatch events.
    let stream: AsyncThrowingStream<[String: Any], Error>

    private var process: Process?
    private var stdinHandle: FileHandle?
    private(set) var readyFrame: [String: Any]?

    enum State: Equatable { case notStarted, starting, ready, stopped, failed }
    private(set) var state: State = .notStarted

    /// Startup timeout. OMP's ready frame usually arrives in well under a
    /// second; 10s is generous enough to absorb a cold node/bun start.
    private static let readyTimeoutNanos: UInt64 = 10_000_000_000
    /// Graceful-stop timeout. OMP exits 0 on stdin close; give it 3s.
    private static let stopTimeoutNanos: UInt64 = 3_000_000_000

    init(binaryPath: String) {
        self.binaryPath = binaryPath
        var cont: AsyncThrowingStream<[String: Any], Error>.Continuation!
        let s = AsyncThrowingStream<[String: Any], Error> { c in cont = c }
        self.stream = s
        self.incomingContBox.withLock { $0 = cont }
    }

    // MARK: - Lifecycle

    func start() async throws {
        guard state == .notStarted else { throw DaniRuntimeError.alreadyRunning }
        state = .starting

        // Wait for the ready frame, racing against a timeout. The readability
        // handler resumes the continuation on the first complete line.
        let ready: [String: Any] = try await withCheckedThrowingContinuation { cont in
            self.readyContBox.withLock { $0 = cont }

            do {
                try self.spawn()
            } catch {
                // Spawn failed — resume immediately so start() throws.
                self.readyContBox.withLock { c -> CheckedContinuation<[String: Any], Error>? in
                    let pending = c; c = nil; return pending
                }?.resume(throwing: error)
                return
            }

            // Startup timeout.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: Self.readyTimeoutNanos)
                guard let self else { return }
                let pending = self.readyContBox.withLock { c -> CheckedContinuation<[String: Any], Error>? in
                    let p = c; c = nil; return p
                }
                pending?.resume(throwing: DaniRuntimeError.startupTimeout)
            }
        }

        guard (ready["type"] as? String) == "ready" else {
            state = .failed
            throw DaniRuntimeError.malformedRpc("first stdout frame was not \"ready\" (got \(ready["type"] ?? "?"))")
        }

        self.readyFrame = ready
        self.state = .ready
    }

    /// Spawn the child process and install stdout/stderr readability handlers.
    private func spawn() throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: binaryPath)
        p.arguments = ["--mode", "rpc"]

        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        p.standardInput = stdinPipe
        p.standardOutput = stdoutPipe
        p.standardError = stderrPipe

        // stdout: line-buffer, parse JSON, resume ready cont on first frame
        // (then yield subsequent frames to the incoming stream).
        var lineBuffer = Data()
        let readyBox = self.readyContBox
        let incomingBox = self.incomingContBox
        stdoutPipe.fileHandleForReading.readabilityHandler = { fh in
            let chunk = fh.availableData
            if chunk.isEmpty {
                // EOF — OMP closed stdout (likely exited). Finish the stream
                // and resume any pending ready wait with an exit error.
                let readyPending = readyBox.withLock { c -> CheckedContinuation<[String: Any], Error>? in
                    let p = c; c = nil; return p
                }
                readyPending?.resume(throwing: DaniRuntimeError.processExitedUnexpectedly(code: nil))
                incomingBox.withLock { $0?.finish() }
                fh.readabilityHandler = nil
                return
            }
            lineBuffer.append(chunk)
            while let nlIdx = lineBuffer.firstIndex(of: 0x0A) {
                let lineData = Data(lineBuffer[lineBuffer.startIndex..<nlIdx])
                lineBuffer.removeSubrange(lineBuffer.startIndex...nlIdx)
                guard !lineData.isEmpty else { continue }
                guard let json = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else {
                    // Malformed line — OMP tolerates; we tolerate. (The OMP
                    // docs say malformed JSON on stdin emits a recoverable
                    // parse failure and doesn't terminate the loop. The
                    // stdout side is well-formed by construction.)
                    continue
                }
                // First frame? Resume the ready wait. Else → incoming stream.
                let readyPending = readyBox.withLock { c -> CheckedContinuation<[String: Any], Error>? in
                    let p = c; c = nil; return p
                }
                if let readyPending {
                    readyPending.resume(returning: json)
                } else {
                    incomingBox.withLock { $0?.yield(json) }
                }
            }
        }

        // stderr: buffer for diagnostics. Pipe serializes handler calls so
        // the captured-buffer mutation is race-free.
        let stderrBuf = self.stderrBuffer
        stderrPipe.fileHandleForReading.readabilityHandler = { fh in
            let chunk = fh.availableData
            if chunk.isEmpty { fh.readabilityHandler = nil; return }
            stderrBuf.withLock { $0.append(chunk) }
        }

        do {
            try p.run()
        } catch {
            state = .failed
            throw error
        }
        self.process = p
        self.stdinHandle = stdinPipe.fileHandleForWriting
    }

    // MARK: - Outbound

    /// Send one command (serialized as JSON + newline). Synchronous write —
    /// commands are small and infrequent (prompt / abort / approve / state).
    func send(_ command: [String: Any]) throws {
        guard state == .ready, let stdin = stdinHandle else {
            throw DaniRuntimeError.notStarted
        }
        let data = try JSONSerialization.data(withJSONObject: command, options: [])
        var withNL = data
        withNL.append(0x0A)
        try stdin.write(contentsOf: withNL)
    }

    // MARK: - Stop

    func stop() async {
        guard let p = process else {
            incomingContBox.withLock { $0?.finish() }
            state = .stopped
            return
        }
        if p.isRunning {
            // Graceful: close stdin. OMP exits 0 on stdin close per docs.
            try? stdinHandle?.close()
            // Poll for exit up to the stop timeout.
            let deadlineNanos = Self.stopTimeoutNanos
            let start = DispatchTime.now()
            while p.isRunning {
                if DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds > deadlineNanos {
                    p.terminate()
                    break
                }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        incomingContBox.withLock { $0?.finish() }
        state = .stopped
    }

    // MARK: - Diagnostics

    /// Buffered stderr from the child process (for the failed-state alert).
    nonisolated func stderrText() -> String {
        stderrBuffer.withLock { String(data: $0, encoding: .utf8) ?? "" }
    }
}
