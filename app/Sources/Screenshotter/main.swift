import AppKit

MainActor.assumeIsolated {
    let args = CommandLine.arguments
    // `mcp`: become the engine's MCP server (on stdin/stdout, with the Node the app carries), so an
    // agent needs one command: `claude mcp add screenshotter -- /Applications/Screenshotter.app/Contents/MacOS/Screenshotter mcp`
    if args.count > 1, args[1] == "mcp" {
        let contents = Bundle.main.bundleURL.appendingPathComponent("Contents")
        let node = contents.appendingPathComponent("Helpers/node").path
        let server = contents.appendingPathComponent("Resources/engine/dist/index.js").path
        // The keys saved in Settings (Unsplash for photo search, Figma for reading Figma files), as
        // the app gives its own engine: an agent's engine is a process of its own, and uses the same keys.
        if (ProcessInfo.processInfo.environment["UNSPLASH_ACCESS_KEY"] ?? "").isEmpty, let unsplash = Keychain.load("unsplash") {
            setenv("UNSPLASH_ACCESS_KEY", unsplash, 1)
        }
        if (ProcessInfo.processInfo.environment["FIGMA_TOKEN"] ?? "").isEmpty, let figma = Keychain.load("figma") {
            setenv("FIGMA_TOKEN", figma, 1)
        }
        var argv: [UnsafeMutablePointer<CChar>?] = ([node, server] + args.dropFirst(2)).map { strdup($0) } + [nil]
        execv(node, &argv)
        FileHandle.standardError.write(Data("Screenshotter couldn't start its MCP server: \(node): \(String(cString: strerror(errno)))\n".utf8))
        exit(1)
    }
    // One Screenshotter at a time (two would each start an engine): a second copy (another build,
    // `open -n`) brings the running one forward and quits.
    if let id = Bundle.main.bundleIdentifier,
       let running = NSRunningApplication.runningApplications(withBundleIdentifier: id)
           .first(where: { $0.processIdentifier != getpid() && $0.activationPolicy == .regular }) {
        NSApplication.shared.yieldActivation(to: running)
        running.unhide()
        running.activate(from: .current, options: [.activateAllWindows])
        exit(0)
    }
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    withExtendedLifetime(delegate) { app.run() }
}
