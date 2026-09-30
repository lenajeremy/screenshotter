import AppKit
import UniformTypeIdentifiers
import WebKit

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    let engine = Engine()
    var window: StudioWindow!
    var web: StudioWebView!

    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"

    var outputFolder: String {
        if let chosen = UserDefaults.standard.string(forKey: "outputFolder"), !chosen.isEmpty { return chosen }
        if let env = engine.environment["SCREENSHOTTER_OUTPUT_DIR"] ?? ProcessInfo.processInfo.environment["SCREENSHOTTER_OUTPUT_DIR"], !env.isEmpty { return env }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Pictures/Screenshotter").path
    }

    // MARK: Launch

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        buildMenu()

        let config = WKWebViewConfiguration()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "native")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.websiteDataStore = .nonPersistent()
        web = StudioWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsMagnification = false
        web.allowsBackForwardNavigationGestures = false
        web.setValue(false, forKey: "drawsBackground")
        web.isInspectable = true
        web.onPasteImages = { [weak self] in self?.importPasteboard() }

        window = StudioWindow()
        window.delegate = self
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        window.layoutTrafficLights()

        showStatus(.starting)
        engine.onChange = { [weak self] state in self?.engineChanged(state) }
        startEngine()
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.async { [weak self] in self?.window.layoutTrafficLights() }
    }

    func startEngine() {
        showStatus(.starting)
        engine.start(outputFolder: outputFolder, apiKey: Keychain.load())
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ note: Notification) { engine.stop() }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    /// Give the page a moment to save an edit it hasn't written yet (it saves half a second after
    /// each change), then quit.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard pageReady, !quitting else { return .terminateNow }
        quitting = true
        web.callAsyncJavaScript("await window.studio?.command('flush')", arguments: [:], in: nil, in: .page) { [weak self] _ in
            self?.finishQuit()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.finishQuit() }
        return .terminateLater
    }
    private var quitting = false
    private var quitAnswered = false
    private func finishQuit() {
        guard !quitAnswered else { return }
        quitAnswered = true
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    /// Files opened with Screenshotter (Finder, "Open With", the Dock icon). They can arrive before
    /// the engine and page are up, so they wait until the Studio has loaded.
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        let urls = filenames.map { URL(fileURLWithPath: $0) }
        if pageReady { upload(urls) } else { pendingOpen += urls }
        sender.reply(toOpenOrPrint: .success)
    }
    private var pendingOpen: [URL] = []
    /// The Studio page (not the status page) has finished loading.
    private var pageReady = false

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let base = engine.baseURL, webView.url?.host == base.host, webView.url?.port == base.port else { return }
        pageReady = true
        if !pendingOpen.isEmpty {
            let urls = pendingOpen
            pendingOpen = []
            upload(urls)
        }
    }

    // MARK: Window

    func windowDidResize(_ note: Notification) { window.layoutTrafficLights() }
    func windowDidBecomeKey(_ note: Notification) { window.layoutTrafficLights() }
    func windowDidEnterFullScreen(_ note: Notification) { setFullScreenClass(true) }
    func windowDidExitFullScreen(_ note: Notification) {
        setFullScreenClass(false)
        window.layoutTrafficLights()
    }
    private func setFullScreenClass(_ on: Bool) {
        web.evaluateJavaScript("document.documentElement.classList.toggle('fullscreen', \(on))")
    }

    // MARK: Engine state → page

    private func engineChanged(_ state: Engine.State) {
        switch state {
        case .running(let url):
            pageReady = false
            web.load(URLRequest(url: url))
        case .failed, .starting, .idle: showStatus(state)
        }
    }

    private func showStatus(_ state: Engine.State) {
        pageReady = false
        web.loadHTMLString(StatusPage.html(for: state, logPath: Engine.logURL.path), baseURL: nil)
    }

    // MARK: Navigation: keep the app on the engine; everything else opens in the browser

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "about" || url.scheme == "data" { return decisionHandler(.allow) }
        if let base = engine.baseURL, url.host == base.host, url.port == base.port, url.path != "/docs" {
            return decisionHandler(.allow)
        }
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.allowedContentTypes = StudioWebView.importableTypes
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let url = engine.baseURL { webView.load(URLRequest(url: url)) }
    }

    // MARK: Bridge (window.webkit.messageHandlers.native)

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return replyHandler(nil, "Bad message") }
        switch cmd {
        case "dragRegions":
            web.dragRegions = DragRegions(regions: DragRegions.from(body["regions"]), holes: DragRegions.from(body["holes"]))
            replyHandler(true, nil)
        case "getSettings":
            replyHandler([
                "hasApiKey": Keychain.load() != nil,
                "outputFolder": outputFolder,
                "version": AppDelegate.version,
                "node": engine.node?.version ?? "",
                "nodePath": engine.node?.path ?? "",
            ], nil)
        case "setApiKey":
            do {
                try Keychain.save(body["key"] as? String ?? "")
                replyHandler(true, nil)
                restartSoon()
            } catch { replyHandler(nil, error.localizedDescription) }
        case "chooseOutputFolder":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.prompt = "Use Folder"
            panel.message = "Captures, imports and exports will be saved here."
            panel.directoryURL = URL(fileURLWithPath: outputFolder)
            panel.beginSheetModal(for: window) { [weak self] response in
                guard response == .OK, let url = panel.url else { return replyHandler(["path": NSNull()], nil) }
                UserDefaults.standard.set(url.path, forKey: "outputFolder")
                replyHandler(["path": url.path], nil)
                self?.restartSoon()
            }
        case "openURL":
            if let s = body["url"] as? String, let url = URL(string: s) { NSWorkspace.shared.open(url) }
            replyHandler(true, nil)
        case "dragFile":
            guard let path = body["path"] as? String, FileManager.default.fileExists(atPath: path) else { return replyHandler(nil, "File not found") }
            web.dragFile(URL(fileURLWithPath: path))
            replyHandler(true, nil)
        case "copyFile":
            guard let path = body["path"] as? String, FileManager.default.fileExists(atPath: path) else { return replyHandler(nil, "File not found") }
            let url = URL(fileURLWithPath: path)
            let pb = NSPasteboard.general
            pb.clearContents()
            var items: [NSPasteboardWriting] = [url as NSURL]
            if let image = NSImage(contentsOf: url) { items.insert(image, at: 0) }
            pb.writeObjects(items)
            replyHandler(true, nil)
        case "pickColor":
            // The system eyedropper: a magnifier that samples any pixel on screen, canvas included.
            let sampler = NSColorSampler()
            colorSampler = sampler
            sampler.show { [weak self] color in
                MainActor.assumeIsolated {
                    self?.colorSampler = nil
                    // No colour (Escape) → an empty reply, which the page treats as cancelled.
                    replyHandler(["hex": color.map(AppDelegate.hex) ?? ""], nil)
                }
            }
        case "copyText":
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(body["text"] as? String ?? "", forType: .string)
            replyHandler(true, nil)
        case "readText":
            replyHandler(["text": NSPasteboard.general.string(forType: .string) ?? ""], nil)
        case "restartEngine":
            replyHandler(true, nil)
            restartSoon()
        case "chooseNode":
            replyHandler(true, nil)
            chooseNode()
        case "showLog":
            NSWorkspace.shared.activateFileViewerSelecting([Engine.logURL])
            replyHandler(true, nil)
        default:
            replyHandler(nil, "Unknown command \(cmd)")
        }
    }

    private var colorSampler: NSColorSampler?

    /// `#rrggbb` in sRGB, the space the page (and the renderer) use.
    nonisolated static func hex(_ color: NSColor) -> String {
        let c = color.usingColorSpace(.sRGB) ?? color
        let v = [c.redComponent, c.greenComponent, c.blueComponent].map { Int((min(1, max(0, $0)) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", v[0], v[1], v[2])
    }

    private func restartSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in self?.startEngine() }
    }

    private func chooseNode() {
        let panel = NSOpenPanel()
        panel.message = "Choose the node executable (version 20 or newer), e.g. /opt/homebrew/bin/node"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.showsHiddenFiles = true
        panel.treatsFilePackagesAsDirectories = true
        panel.directoryURL = URL(fileURLWithPath: "/usr/local/bin")
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            UserDefaults.standard.set(url.path, forKey: "nodePath")
            self?.startEngine()
        }
    }

    // MARK: Importing files (paste, Open…, dropped on the Dock icon)

    func importPasteboard() {
        let pb = NSPasteboard.general
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            return upload(urls)
        }
        var data = pb.data(forType: .png)
        if data == nil, let tiff = pb.data(forType: .tiff), let rep = NSBitmapImageRep(data: tiff) { data = rep.representation(using: .png, properties: [:]) }
        guard let png = data else { return }
        uploadData([("pasted.png", png)])
    }

    func upload(_ urls: [URL]) {
        let accepted = urls.filter { u in StudioWebView.importableTypes.contains { UTType(filenameExtension: u.pathExtension)?.conforms(to: $0) == true } }
        var files: [(String, Data)] = []
        for u in accepted {
            guard var data = try? Data(contentsOf: u) else { continue }
            var name = u.lastPathComponent
            // The engine takes PNG/JPEG/WebP; convert TIFF/HEIC first.
            if ["tif", "tiff", "heic"].contains(u.pathExtension.lowercased()), let rep = NSImage(data: data).flatMap({ $0.tiffRepresentation }).flatMap(NSBitmapImageRep.init(data:)), let png = rep.representation(using: .png, properties: [:]) {
                data = png
                name = u.deletingPathExtension().lastPathComponent + ".png"
            }
            files.append((name, data))
        }
        uploadData(files)
    }

    private func uploadData(_ files: [(String, Data)]) {
        guard let base = engine.baseURL, !files.isEmpty else { return }
        Task {
            // The engine's answer for each file ({path, poster?, width?, height?}) goes to the page
            // as is, so recordings can be matched to a device by shape.
            var items: [[String: Any]] = []
            for (name, data) in files {
                var components = URLComponents(url: base.appendingPathComponent("api/upload"), resolvingAgainstBaseURL: false)!
                components.queryItems = [URLQueryItem(name: "name", value: name)]
                var req = URLRequest(url: components.url!)
                req.httpMethod = "POST"
                req.setValue("studio", forHTTPHeaderField: "x-screenshotter")
                req.httpBody = data
                if let (body, _) = try? await URLSession.shared.data(for: req),
                   let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any], json["path"] is String {
                    items.append(json)
                }
            }
            let list = String(decoding: (try? JSONSerialization.data(withJSONObject: items)) ?? Data("[]".utf8), as: UTF8.self)
            _ = try? await web.evaluateJavaScript("window.studio && window.studio.command('imported', \(list))")
        }
    }

    // MARK: Menu

    @objc func command(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        web.evaluateJavaScript("window.studio && window.studio.command('\(name)')")
    }
    @objc func openFilesPanel(_ sender: Any?) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = StudioWebView.importableTypes
        panel.message = "Choose screenshots or screen recordings to add."
        panel.beginSheetModal(for: window) { [weak self] r in if r == .OK { self?.upload(panel.urls) } }
    }
    @objc func revealOutput(_ sender: Any?) {
        let url = URL(fileURLWithPath: outputFolder)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.open(url)
    }
    @objc func restartEngine(_ sender: Any?) { startEngine() }
    @objc func openDocs(_ sender: Any?) {
        if let base = engine.baseURL { NSWorkspace.shared.open(base.appendingPathComponent("docs")) }
    }
    @objc func reloadUI(_ sender: Any?) { web.reload() }

    private func item(_ title: String, _ command: String, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: #selector(command(_:)), keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        i.representedObject = command
        i.target = self
        return i
    }
    private func action(_ title: String, _ sel: Selector, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        i.target = target
        return i
    }

    private func buildMenu() {
        let main = NSMenu()
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let m = NSMenu(title: title)
            items.forEach(m.addItem)
            let holder = NSMenuItem()
            holder.submenu = m
            main.addItem(holder)
            return m
        }
        _ = submenu("Screenshotter", [
            action("About Screenshotter", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Settings…", "settings", ","),
            .separator(),
            action("Hide Screenshotter", #selector(NSApplication.hide(_:)), "h"),
            action("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            action("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            action("Quit Screenshotter", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = submenu("File", [
            item("New Design", "newScene", "n"),
            action("Import Screenshots…", #selector(openFilesPanel(_:)), "o", target: self),
            .separator(),
            item("Export Image", "exportImage", "e"),
            item("Export Video", "exportVideo", "e", [.command, .shift]),
            .separator(),
            action("Show Output Folder", #selector(revealOutput(_:)), "", target: self),
            action("Restart Engine", #selector(restartEngine(_:)), "", target: self),
            .separator(),
            action("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        _ = submenu("Edit", [
            item("Undo", "undo", "z"),
            item("Redo", "redo", "z", [.command, .shift]),
            .separator(),
            action("Cut", #selector(NSText.cut(_:)), "x"),
            action("Copy", #selector(NSText.copy(_:)), "c"),
            action("Paste", #selector(NSText.paste(_:)), "v"),
            action("Select All", #selector(NSText.selectAll(_:)), "a"),
            .separator(),
            item("Duplicate", "duplicate", "d"),
        ])
        _ = submenu("View", [
            item("Edit", "canvas", "1"),
            item("Preview", "showPreview", "2"),
            item("Update Preview", "preview", "r"),
            .separator(),
            item("Zoom In", "zoomIn", "="),
            item("Zoom Out", "zoomOut", "-"),
            item("Zoom to Fit", "fit", "0"),
            .separator(),
            item("Toggle Side Panel", "toggleLeft", "s", [.command, .option]),
            item("Scene JSON", "json", "j", [.command, .option]),
            .separator(),
            action("Reload Interface", #selector(reloadUI(_:)), "r", [.command, .option, .shift], target: self),
            action("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        _ = submenu("AI", [item("Ask AI…", "ai", "k")])
        let win = submenu("Window", [
            action("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            action("Zoom", #selector(NSWindow.performZoom(_:))),
        ])
        NSApp.windowsMenu = win
        let help = submenu("Help", [
            item("How Screenshotter Works", "help"),
            action("Documentation", #selector(openDocs(_:)), "?", target: self),
        ])
        NSApp.helpMenu = help
        NSApp.mainMenu = main
    }
}

/// The page shown while the engine starts, or when it can't.
enum StatusPage {
    static func html(for state: Engine.State, logPath: String) -> String {
        var title = "Starting Screenshotter"
        var body = "Warming up the engine…"
        var actions = ""
        var spinner = true
        if case .failed(let reason) = state {
            spinner = false
            if reason == "node" {
                title = "Screenshotter needs Node.js"
                body = "Install Node.js 20 or newer (from nodejs.org, or run <code>brew install node</code>), then try again. If it's already installed somewhere unusual, choose it."
                actions = "<button class='primary' onclick=\"post('restartEngine')\">Try again</button><button onclick=\"post('chooseNode')\">Choose Node…</button><button onclick=\"post('openURL',{url:'https://nodejs.org/en/download'})\">Get Node.js</button>"
            } else {
                title = "The engine didn't start"
                body = escape(reason).replacingOccurrences(of: "\n", with: "<br>")
                actions = "<button class='primary' onclick=\"post('restartEngine')\">Try again</button><button onclick=\"post('showLog')\">Show log</button>"
            }
        }
        return """
        <!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0;height:100%;background:#0b0b0d;color:#f4f4f5;font:13px/1.5 -apple-system,system-ui,sans-serif;-webkit-user-select:none;cursor:default}
        .wrap{height:100%;display:grid;place-items:center;text-align:center;padding:40px}
        .card{max-width:460px;display:flex;flex-direction:column;align-items:center;gap:14px}
        h1{margin:0;font:400 30px "New York",ui-serif,Georgia,serif;letter-spacing:-.02em}
        p{margin:0;color:#8b8b94}
        code{font:12px ui-monospace,Menlo,monospace;background:#1c1c20;padding:2px 6px;border-radius:5px;color:#d4d4d8}
        .ring{width:30px;height:30px;border-radius:50%;box-sizing:border-box;border:2.5px solid rgba(255,255,255,.1);border-top-color:#d2ff4d;animation:spin .8s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
        .row{display:flex;gap:8px;margin-top:6px}
        button{height:34px;padding:0 14px;border-radius:9px;border:0;background:#1c1c20;color:#f4f4f5;font:600 12.5px -apple-system,system-ui;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
        button:hover{background:#26262b}
        button.primary{background:#d2ff4d;color:#0d1100;box-shadow:none}
        </style></head><body><div class="wrap"><div class="card">
        \(spinner ? "<div class='ring'></div>" : "")
        <h1>\(title)</h1><p>\(body)</p><div class="row">\(actions)</div>
        </div></div><script>
        function post(cmd, extra){ return window.webkit.messageHandlers.native.postMessage(Object.assign({cmd}, extra||{})); }
        // No title bar of its own: the top strip moves the window, as in the Studio.
        function drag(){ post('dragRegions', {regions: [[0, 0, innerWidth, 52]], holes: []}); }
        drag(); addEventListener('resize', drag);
        </script></body></html>
        """
    }

    static func escape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
    }
}
