import Foundation

/// Apps opened from Finder don't inherit the user's shell setup, so PATH, API keys and tool
/// locations (node, ffmpeg, claude) are read from a login shell once at launch.
enum ShellEnvironment {
    static let marker = "__SCREENSHOTTER_ENV__"

    static func resolve(timeout: TimeInterval = 6) -> [String: String] {
        let base = ProcessInfo.processInfo.environment
        let shell = base["SHELL"].flatMap { FileManager.default.isExecutableFile(atPath: $0) ? $0 : nil } ?? "/bin/zsh"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-l", "-i", "-c", "printf '\\n\(marker)\\n'; /usr/bin/env -0"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        var env = base
        env["SCREENSHOTTER_RESOLVING_ENV"] = "1"
        p.environment = env
        do { try p.run() } catch { return base }
        let deadline = Date().addingTimeInterval(timeout)
        let data = out.fileHandleForReading
        var buffer = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global().async {
            buffer = data.readDataToEndOfFile()
            group.leave()
        }
        if group.wait(timeout: .now() + max(0.5, deadline.timeIntervalSinceNow)) == .timedOut {
            p.terminate()
            return base
        }
        let parsed = parse(buffer)
        return parsed.isEmpty ? base : base.merging(parsed) { _, shellValue in shellValue }
    }

    /// Parse `env -0` output that follows the marker line.
    static func parse(_ data: Data) -> [String: String] {
        guard let text = String(data: data, encoding: .utf8), let range = text.range(of: "\n\(marker)\n") else { return [:] }
        var result: [String: String] = [:]
        for entry in text[range.upperBound...].split(separator: "\0") {
            guard let eq = entry.firstIndex(of: "=") else { continue }
            let key = String(entry[..<eq])
            guard !key.isEmpty, !key.contains("\n") else { continue }
            result[key] = String(entry[entry.index(after: eq)...])
        }
        result.removeValue(forKey: "SCREENSHOTTER_RESOLVING_ENV")
        return result
    }
}

enum NodeLocator {
    struct Found: Equatable { var path: String; var version: String }

    /// "v24.11.1" → 24
    static func major(_ version: String) -> Int? {
        let digits = version.trimmingCharacters(in: .whitespacesAndNewlines).drop { $0 == "v" }
        return Int(digits.split(separator: ".").first ?? "")
    }

    static func candidates(path: String?, home: String) -> [String] {
        var list: [String] = []
        if let override = UserDefaults.standard.string(forKey: "nodePath"), !override.isEmpty { list.append(override) }
        // The Node the app carries (Contents/Helpers; Resources in older builds).
        list.append(Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/node").path)
        if let older = Bundle.main.resourceURL?.appendingPathComponent("node").path { list.append(older) }
        for dir in (path ?? "").split(separator: ":") { list.append("\(dir)/node") }
        list += ["/opt/homebrew/bin/node", "/usr/local/bin/node", "\(home)/.volta/bin/node", "\(home)/.asdf/shims/node", "\(home)/.local/share/mise/shims/node"]
        let nvm = URL(fileURLWithPath: "\(home)/.nvm/versions/node")
        let versions = ((try? FileManager.default.contentsOfDirectory(atPath: nvm.path)) ?? []).sorted { (major($0) ?? 0) > (major($1) ?? 0) }
        list += versions.map { "\(nvm.path)/\($0)/bin/node" }
        var seen = Set<String>()
        return list.filter { seen.insert($0).inserted }
    }

    static func find(env: [String: String]) -> Found? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for path in candidates(path: env["PATH"], home: home) where FileManager.default.isExecutableFile(atPath: path) {
            guard let version = run(path, ["--version"]), let m = major(version), m >= 20 else { continue }
            return Found(path: path, version: version.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return nil
    }

    private static func run(_ exe: String, _ args: [String]) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        p.arguments = args
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0 ? String(data: data, encoding: .utf8) : nil
    }
}
