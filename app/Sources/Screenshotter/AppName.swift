import Foundation

/// This copy of the app's name (CFBundleName): "Screenshotter", or another name a separate build
/// was given (npm run app:build with SCREENSHOTTER_APP_NAME). Its library, logs, Keychain items and
/// engine note are named after it, so two copies never share them.
enum AppName {
    static let name = (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Screenshotter"
    /// Where the engine notes its library, for agents' MCP servers to find it.
    static var studioFile: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/\(name)/studio.json").path
    }
}
