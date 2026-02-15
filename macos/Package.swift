// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TaskScore",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "TaskScoreLib", targets: ["TaskScoreLib"]),
        .executable(name: "detect-events", targets: ["DetectEvents"]),
    ],
    targets: [
        // Shared analysis library (no SwiftUI dependency)
        .target(
            name: "TaskScoreLib",
            path: "TaskScoreLib"
        ),
        // CLI tool for comparing event detection output
        .executableTarget(
            name: "DetectEvents",
            dependencies: ["TaskScoreLib"],
            path: "DetectEvents"
        ),
        .testTarget(
            name: "TaskScoreTests",
            dependencies: ["TaskScoreLib"],
            path: "TaskScoreTests"
        ),
    ]
)
