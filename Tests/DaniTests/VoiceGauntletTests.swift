import XCTest
@testable import Dani

// VOICE GAUNTLET (spec layer 2)
// ---------------------------
// "Hold Fn. Say: 'Reply exactly DANI_VOICE_OK'. Verify transcript reaches
// OMP."
//
// This file exercises the OMP-side of the voice path programmatically — it
// sends the same prompt text the Fn→record→transcribe→deliverFinal path
// would send, and verifies the run completes with the expected text. The
// Fn + mic side is human-driven; see GAUNTLET.md for the manual procedure.
//
// Skips by default. Enable with `DANI_GAUNTLET=1` so a CI run without intent
// doesn't accidentally burn a model call. Also skips when OMP isn't
// installed.

@MainActor
final class VoiceGauntletTests: XCTestCase {

    func testVoicePromptReachesOMP() async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["DANI_GAUNTLET"] == "1",
            "Set DANI_GAUNTLET=1 to run the voice gauntlet (it makes a real model call)."
        )
        guard OmpBinaryDiscovery.resolve() != nil else {
            throw XCTSkip("OMP binary not found")
        }

        let runtime = OmpRpcRuntime()
        do {
            try await runtime.start()
            // This is the exact transcript the voice path would deliver after
            // Fn down → "Reply exactly DANI_VOICE_OK" → Fn up.
            let run = try await runtime.prompt("Reply exactly DANI_VOICE_OK")

            var text = ""
            var completed = false
            var failedMsg: String?
            for try await event in run {
                switch event {
                case .textDelta(let s): text += s
                case .completed(let final):
                    if let final, !final.isEmpty { text += final }
                    completed = true
                case .failed(let msg): failedMsg = msg
                default: break
                }
            }

            XCTAssertNil(failedMsg, "voice gauntlet run failed: \(failedMsg ?? "")")
            XCTAssertTrue(completed, "voice gauntlet run did not complete")
            XCTAssertTrue(
                text.contains("DANI_VOICE_OK"),
                "Expected DANI_VOICE_OK in response; got: \(text)"
            )
        } catch {
            await runtime.stop()
            throw error
        }
        await runtime.stop()
    }
}
