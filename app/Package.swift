// swift-tools-version: 5.9
import PackageDescription

// A small AppKit shell: one window hosting the Studio web UI, plus the local engine process.
let package = Package(
    name: "Screenshotter",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Screenshotter", targets: ["Screenshotter"])],
    targets: [
        .executableTarget(name: "Screenshotter", path: "Sources/Screenshotter"),
        .testTarget(name: "ScreenshotterTests", dependencies: ["Screenshotter"], path: "Tests/ScreenshotterTests"),
    ]
)
