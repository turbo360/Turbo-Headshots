// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "headshot-sidecar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "HeadshotSidecar",
            path: "Sources/HeadshotSidecar"
        )
    ]
)
