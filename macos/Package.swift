// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TaskScore",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "TaskScore", targets: ["TaskScore"]),
        .executable(name: "detect-events", targets: ["DetectEvents"]),
    ],
    targets: [
        // Shared analysis library (no SwiftUI dependency)
        .target(
            name: "TaskScoreLib",
            path: "TaskScoreLib"
        ),
        // macOS app
        .executableTarget(
            name: "TaskScore",
            dependencies: ["TaskScoreLib"],
            path: "TaskScore",
            resources: [
                .process("Resources"),
            ]
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
