// swift-tools-version: 5.9
import PackageDescription

// A small AppKit shell: one window hosting the Studio web UI, plus the local engine process.
let package = Package(
    name: "Screenshotter",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Screenshotter", targets: ["Screenshotter"])],
    // Sparkle: updates for an app sold outside the App Store (a new version offered, downloaded,
    // checked against our signing key and installed).
    dependencies: [.package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0")],
    targets: [
        .executableTarget(name: "Screenshotter", dependencies: [.product(name: "Sparkle", package: "Sparkle")], path: "Sources/Screenshotter"),
        // Sparkle.framework is built beside the test bundle (Products/Debug), which isn't on its search
        // path by default: without this, `swift test` can't load the bundle at all.
        .testTarget(name: "ScreenshotterTests", dependencies: ["Screenshotter"], path: "Tests/ScreenshotterTests",
                    linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@loader_path/../../.."])]),
    ]
)
