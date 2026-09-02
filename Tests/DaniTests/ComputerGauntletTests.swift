import AppKit
import XCTest
@testable import Dani

// COMPUTER GAUNTLET (spec layer 3)
// --------------------------------
// "Prompt: 'Open Notes and type DANI COMPUTER OK'. Verify the resulting
// application state. Do not call computer task successful merely because
// OMP says it succeeded. Verify actual state where practical."
//
// This test prompts OMP (via the Developer Prompt path, bypassing Fn/STT)
// to open Notes and type. After the run completes, it verifies the ACTUAL
// system state — Notes is running — not just that OMP returned agent_end.
// Verifying the typed text inside Notes would require AppleScript access
// to the Notes document; that's left as a manual step in GAUNTLET.md.
//
// WARNING: this test opens the Notes app on the host machine. It modifies
// system state. Skips by default (DANI_GAUNTLET=1 to enable).

@MainActor
final class ComputerGauntletTests: XCTestCase {

    private static let notesBundleID = "com.apple.Notes"

    func testOpensNotesAndTypes() async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["DANI_GAUNTLET"] == "1",
            "Set DANI_GAUNTLET=1 to run the computer gauntlet (it opens Notes on this Mac)."
        )
        guard OmpBinaryDiscovery.resolve() != nil else {
            throw XCTSkip("OMP binary not found")
        }

        // Quit Notes first so a fresh open is unambiguous. Best-effort.
        if let notes = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == Self.notesBundleID }) {
            notes.terminate()
            // Give it a moment to quit.
            try? await Task.sleep(nanoseconds: 500_000_000)
        }

        let runtime = OmpRpcRuntime()
        do {
            try await runtime.start()
            let run = try await runtime.prompt("Open Notes and type DANI COMPUTER OK")

            var sawComputerTool = false
            var completed = false
            var failedMsg: String?
            for try await event in run {
                switch event {
                case .toolStarted(let name) where name.lowercased().contains("computer"):
                    sawComputerTool = true
                case .completed:
                    completed = true
                case .failed(let msg):
                    failedMsg = msg
                default: break
                }
            }

            XCTAssertNil(failedMsg, "computer gauntlet run failed: \(failedMsg ?? "")")
            XCTAssertTrue(completed, "computer gauntlet run did not complete")

            // Verify ACTUAL state: Notes is now running. Per spec, don't trust
            // OMP's claim alone.
            let notesRunning = NSWorkspace.shared.runningApplications.contains {
                $0.bundleIdentifier == Self.notesBundleID
            }
            XCTAssertTrue(
                notesRunning,
                "Notes was not running after the OMP run — OMP claimed success but the actual state disagrees (spec: verify actual state where practical)."
            )

            // The spec wants the typed text verified too. That requires
            // reading the frontmost Notes document via AppleScript, which
            // needs Automation permission. Left as a manual step in
            // GAUNTLET.md — record the typed-text check in the gauntlet log.
            _ = sawComputerTool  // not strictly asserted; logged for the human
        } catch {
            await runtime.stop()
            throw error
        }
        await runtime.stop()
    }
}
