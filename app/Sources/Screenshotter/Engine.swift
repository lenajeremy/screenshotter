import Foundation

/// Runs the Screenshotter engine (`node dist/index.js studio`) on a free localhost port.
///
/// The engine's stdin is a pipe this app never writes to: if the app quits or crashes the pipe
/// closes and the engine exits too (`--watch-stdin`), so no server is left behind.
@MainActor final class Engine {
    enum State: Equatable { case idle, starting, running(URL), failed(String) }

    private(set) var state: State = .idle
    var onChange: ((State) -> Void)?
    private(set) var node: NodeLocator.Found?
    private(set) var environment: [String: String] = [:]
    private(set) var recentLog = ""

    private var process: Process?
    private var stdinPipe: Pipe?
    private var generation = 0
    private var logHandle: FileHandle?

    static var logURL: URL {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Screenshotter", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("engine.log")
    }

    /// Where the engine lives: bundled in the app, or a checkout named by SCREENSHOTTER_ENGINE_DIR.
    static func engineRoot(env: [String: String]) -> URL? {
        if let dev = env["SCREENSHOTTER_ENGINE_DIR"], FileManager.default.fileExists(atPath: "\(dev)/dist/index.js") {
            return URL(fileURLWithPath: dev)
        }
        guard let bundled = Bundle.main.resourceURL?.appendingPathComponent("engine"),
              FileManager.default.fileExists(atPath: bundled.appendingPathComponent("dist/index.js").path) else { return nil }
        return bundled
    }

    func start(outputFolder: String, apiKey: String?) {
        stop()
        generation += 1
        let mine = generation
        set(.starting)
        Task.detached(priority: .userInitiated) {
            let env = ShellEnvironment.resolve()
            let node = NodeLocator.find(env: env)
            await MainActor.run { self.launch(mine: mine, env: env, node: node, outputFolder: outputFolder, apiKey: apiKey) }
        }
    }

    private func launch(mine: Int, env shellEnv: [String: String], node: NodeLocator.Found?, outputFolder: String, apiKey: String?) {
        guard mine == generation else { return }
        guard let node else {
            return set(.failed("node"))
        }
        guard let root = Engine.engineRoot(env: shellEnv) else {
            return set(.failed("Screenshotter's engine is missing from the app. Rebuild it with npm run app:build."))
        }
        self.node = node
        var env = shellEnv
        let nodeDir = (node.path as NSString).deletingLastPathComponent
        env["PATH"] = ([nodeDir, "/opt/homebrew/bin", "/usr/local/bin"] + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init))
            .reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
            .joined(separator: ":")
        env["SCREENSHOTTER_OUTPUT_DIR"] = outputFolder
        env["SCREENSHOTTER_APP"] = "1"
        if let apiKey, !apiKey.isEmpty { env["ANTHROPIC_API_KEY"] = apiKey }
        env.removeValue(forKey: "SCREENSHOTTER_STUDIO_PORT")
        environment = env

        let p = Process()
        p.executableURL = URL(fileURLWithPath: node.path)
        p.arguments = [root.appendingPathComponent("dist/index.js").path, "studio", "--port", "0", "--no-open", "--watch-stdin"]
        p.currentDirectoryURL = root
        p.environment = env
        let input = Pipe()
        let errors = Pipe()
        p.standardInput = input
        p.standardOutput = FileHandle.nullDevice
        p.standardError = errors
        stdinPipe = input
        recentLog = ""
        FileManager.default.createFile(atPath: Engine.logURL.path, contents: Data("— \(Date()) · \(node.path) \(node.version)\n".utf8))
        logHandle = try? FileHandle(forWritingTo: Engine.logURL)
        logHandle?.seekToEndOfFile()

        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            let text = String(decoding: data, as: UTF8.self)
            Task { @MainActor in self?.consume(text, data: data, mine: mine) }
        }
        p.terminationHandler = { [weak self] proc in
            Task { @MainActor in
                guard let self, mine == self.generation else { return }
                self.process = nil
                let tail = self.recentLog.split(separator: "\n").suffix(6).joined(separator: "\n")
                self.set(.failed("The engine stopped (exit \(proc.terminationStatus)).\(tail.isEmpty ? "" : "\n\n\(tail)")"))
            }
        }
        do {
            try p.run()
            process = p
        } catch {
            set(.failed("Couldn't start Node at \(node.path): \(error.localizedDescription)"))
            return
        }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 45_000_000_000)
            guard let self, mine == self.generation, self.state == .starting else { return }
            self.stop()
            self.set(.failed("The engine didn't start within 45 seconds. See ~/Library/Logs/Screenshotter/engine.log."))
        }
    }

    private func consume(_ text: String, data: Data, mine: Int) {
        guard mine == generation else { return }
        logHandle?.write(data)
        recentLog = String((recentLog + text).suffix(8000))
        if state == .starting, let port = Engine.port(in: recentLog), let url = URL(string: "http://127.0.0.1:\(port)/") {
            set(.running(url))
        }
    }

    /// Finds the `SCREENSHOTTER_STUDIO_PORT=1234` line the engine prints once it listens.
    nonisolated static func port(in log: String) -> Int? {
        guard let r = log.range(of: #"SCREENSHOTTER_STUDIO_PORT=(\d+)"#, options: .regularExpression) else { return nil }
        return Int(log[r].split(separator: "=").last ?? "")
    }

    func stop() {
        generation += 1
        if let p = process {
            p.terminationHandler = nil
            if p.isRunning { p.terminate() }
            let pid = p.processIdentifier
            DispatchQueue.global().asyncAfter(deadline: .now() + 3) { if kill(pid, 0) == 0 { kill(pid, SIGKILL) } }
        }
        try? stdinPipe?.fileHandleForWriting.close()
        process = nil
        stdinPipe = nil
        try? logHandle?.close()
        logHandle = nil
        if case .running = state { state = .idle }
    }

    private func set(_ s: State) {
        state = s
        onChange?(s)
    }

    var baseURL: URL? { if case .running(let url) = state { return url }; return nil }
}
