// swift-tools-version: 5.9
import PackageDescription

// DANI Desktop — native macOS peripheral for OMP (Oh My Pi).
//
// Architecture (one engineer, ~10 minutes):
//
//   Sources/DaniApp/      executable; app entry + AppDelegate orchestrator
//   Sources/Input/        Fn key monitor + voice capture (mic routing)
//   Sources/Speech/       Apple Speech STT transcriber
//   Sources/Runtime/      DaniRuntime protocol + OMP RPC runtime
//   Sources/UI/           floating overlay + status + settings + l10n
//   Sources/Permissions/  mic / speech / accessibility gate
//
// The library target `Dani` spans Sources/ (excluding the executable dir)
// so subdirs are organizational, not separate modules. This keeps the import
// surface to a single `import Dani` and avoids a 6-target dependency graph
// for an app that one engineer should understand in 10 minutes.
let package = Package(
    name: "Dani",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "Dani",
            path: "Sources",
            exclude: ["DaniApp"]
        ),
        .executableTarget(
            name: "DaniApp",
            dependencies: ["Dani"],
            path: "Sources/DaniApp"
        ),
        .testTarget(
            name: "DaniTests",
            dependencies: ["Dani"],
            path: "Tests/DaniTests"
        ),
    ]
)
