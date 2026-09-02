import XCTest
@testable import Dani

/// Placeholder so the `DaniTests` target has at least one source file (SwiftPM
/// rejects empty test targets). Real tests are added in later commits:
///
///   - OmpRpcRuntimeTests: launch OMP, prompt "Reply exactly DANI_RUNTIME_OK",
///     verify ready → prompt ack → text delta → agent_end(isTerminal != false).
///   - VoiceGauntletTests: Fn hold → "Reply exactly DANI_VOICE_OK" → verify
///     transcript reaches OMP. (Manual / hardware-dependent.)
///   - ComputerTaskTests: prompt "Open Notes and type DANI COMPUTER OK" →
///     verify the resulting app state. (Manual / hardware-dependent.)
final class DaniTestsPlaceholder: XCTestCase {
    func testPackageResolves() {
        // If this file compiles and runs, the `Dani` library target links and
        // `@testable import Dani` works. Real assertions come with the runtime
        // smoke test in a later commit.
        XCTAssertTrue(true)
    }
}
