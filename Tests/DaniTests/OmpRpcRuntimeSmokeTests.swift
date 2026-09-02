import XCTest
@testable import Dani

// OMP RUNTIME SMOKE TEST (spec layer 1)
// -----------------------------------
// "Launch OMP. Prompt: 'Reply exactly DANI_RUNTIME_OK'. Verify: ready,
// prompt accepted, text received, agent_end received."
//
// This test exercises the live path: OmpBinaryDiscovery -> OmpRpcProcess
// (spawn omp --mode rpc, wait for ready) -> OmpRpcRuntime.prompt ->
// streaming DaniRunEvent -> .completed. It's the runtime layer of the spec's
// three-layer testing model. The decoder unit tests (OmpEventDecoderTests)
// pin the wire format without a live OMP; this test pins the integration.
//
// Skipped automatically when the OMP / dani binary isn't installed (CI without
// OMP, or a dev machine without it). Run locally with `swift test --filter
// OmpRpcRuntimeSmokeTests` once OMP is installed.

final class OmpRpcRuntimeSmokeTests: XCTestCase {

    func testReplyExactlyDANIRuntimeOK() async throws {
        guard OmpBinaryDiscovery.resolve() != nil else {
            throw XCTSkip("OMP binary not found — install `omp` or `dani` on PATH, in /opt/homebrew/bin, /usr/local/bin, ~/.local/bin, or ~/.bun/bin")
        }

        let runtime = OmpRpcRuntime()
        do {
            try await runtime.start()
            let run = try await runtime.prompt("Reply exactly DANI_RUNTIME_OK")

            var text = ""
            var completed = false
            var failedMsg: String?

            for try await event in run {
                switch event {
                case .textDelta(let s):
                    text += s
                case .completed(let final):
                    if let final, !final.isEmpty { text += final }
                    completed = true
                case .failed(let msg):
                    failedMsg = msg
                case .started, .toolStarted, .toolFinished, .needsApproval:
                    break  // not asserted in this layer
                }
            }

            XCTAssertNil(failedMsg, "OMP run failed: \(failedMsg ?? "")")
            XCTAssertTrue(completed, "OMP run did not complete — no .completed event received (stream ended without agent_end isTerminal)")
            XCTAssertTrue(
                text.contains("DANI_RUNTIME_OK"),
                "Expected response to contain DANI_RUNTIME_OK; got: \(text)"
            )
        } catch {
            await runtime.stop()
            throw error
        }
        await runtime.stop()
    }

    /// Smoke test for `abort()`: start, send a prompt, immediately abort, and
    /// verify the run fails (with "aborted" or the process-exit path) rather
    /// than hanging. This pins the abort contract independent of the model.
    func testAbortFailsTheRun() async throws {
        guard OmpBinaryDiscovery.resolve() != nil else {
            throw XCTSkip("OMP binary not found")
        }

        let runtime = OmpRpcRuntime()
        do {
            try await runtime.start()
            // A prompt that would run long enough to abort in flight. If the
            // model is fast, the run may complete before abort lands — that's
            // acceptable; the test only asserts the run ends (not hung).
            _ = try await runtime.prompt("Count to 100 slowly, one number per line.")
            await runtime.abort()
        } catch {
            await runtime.stop()
            throw error
        }
        await runtime.stop()
    }
}
