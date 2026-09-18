// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "engine",
    platforms: [.macOS("15.0")],
    targets: [
        .executableTarget(name: "engine")
    ]
)
