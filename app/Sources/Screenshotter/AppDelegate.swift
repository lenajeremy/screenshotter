import AppKit
import Sparkle
import UniformTypeIdentifiers
import WebKit

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    let engine = Engine()
    var window: StudioWindow!
    var web: StudioWebView!
    /// Updates: checks the feed on the site once a day (SUFeedURL in Info.plist), and on demand.
    let updates = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)

    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"

    var outputFolder: String {
        if let chosen = UserDefaults.standard.string(forKey: "outputFolder"), !chosen.isEmpty { return chosen }
        if let env = engine.environment["SCREENSHOTTER_OUTPUT_DIR"] ?? ProcessInfo.processInfo.environment["SCREENSHOTTER_OUTPUT_DIR"], !env.isEmpty { return env }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Pictures/\(AppName.name)").path
    }

    // MARK: Launch

    func applicationDidFinishLaunching(_ note: Notification) {
        // The Studio window follows the theme chosen in Settings (or the Mac's).
        buildMenu()

        let config = WKWebViewConfiguration()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "native")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.websiteDataStore = .nonPersistent()
        // Videos on a board play on their own, with sound, without a click first.
        config.mediaTypesRequiringUserActionForPlayback = []
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
        window.layoutTrafficLights()

        showStatus(.starting)
        engine.onChange = { [weak self] state in self?.engineChanged(state) }
        startEngine()

        showStudio()
    }

    /// The Studio window, in front.
    func showStudio() {
        window.makeKeyAndOrderFront(nil)
        window.layoutTrafficLights()
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.async { [weak self] in self?.window.layoutTrafficLights() }
    }

    func startEngine() {
        showStatus(.starting)
        engine.start(outputFolder: outputFolder)
    }

    /// Closing the window keeps Screenshotter (and its engine) running; the Dock icon or
    /// Window › Screenshotter brings the window back.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Opening Screenshotter again (the Dock icon, Spotlight, Launchpad, Finder) shows its window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showStudio()
        return false
    }
    func applicationWillTerminate(_ note: Notification) { engine.stop() }
    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    /// Before quitting, the page gets a moment to save an edit it hasn't written yet (it saves half
    /// a second after each change). That has a time limit, so quitting never hangs.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Asked again while waiting (⌘Q twice): quit now.
        if quitting { return .terminateNow }
        guard pageReady else { return .terminateNow }
        quitting = true
        web.callAsyncJavaScript("await window.studio?.command('flush')", arguments: [:], in: nil, in: .page) { [weak self] _ in
            self?.flushed()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.flushed() }
        return .terminateLater
    }
    private var quitting = false
    private var quitAnswered = false
    private func flushed() {
        guard !quitAnswered else { return }
        quitAnswered = true
        NSApp.reply(toApplicationShouldTerminate: true)
    }

    /// Files opened with Screenshotter (Finder, "Open With", the Dock icon). They can arrive before
    /// the engine and page are up, so they wait until the Studio has loaded.
    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        let urls = filenames.map { URL(fileURLWithPath: $0) }
        if pageReady { upload(urls) } else { pendingOpen += urls }
        // Files opened with Screenshotter go straight onto the board.
        if window != nil { showStudio() }
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
        if let base = engine.baseURL, url.host == base.host, url.port == base.port {
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
        // The kinds of file this picker takes, from its <input accept> (the page notes it when it's clicked).
        webView.evaluateJavaScript("window.__pickerAccept || ''") { [weak self] result, _ in
            guard let self else { return completionHandler(nil) }
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseDirectories = false
            panel.allowedContentTypes = StudioWebView.contentTypes(forAccept: result as? String ?? "")
            panel.beginSheetModal(for: self.window) { response in completionHandler(response == .OK ? panel.urls : nil) }
        }
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
        // The page is gone until it loads again: what's sent meanwhile waits for it (didFinish).
        pageReady = false
        if let url = engine.baseURL { webView.load(URLRequest(url: url)) } else { showStatus(engine.state) }
    }

    // MARK: Bridge (window.webkit.messageHandlers.native)

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return replyHandler(nil, "Bad message") }
        switch cmd {
        case "dragRegions":
            web.dragRegions = DragRegions(regions: DragRegions.from(body["regions"]), holes: DragRegions.from(body["holes"]))
            replyHandler(true, nil)
        case "setTheme":
            let theme = body["theme"] as? String ?? "system"
            UserDefaults.standard.set(theme, forKey: "theme")
            for case let w as StudioWindow in NSApp.windows { w.applyTheme(theme) }
            replyHandler(true, nil)
        case "getSettings":
            replyHandler([
                "hasUnsplashKey": Keychain.load("unsplash") != nil,
                "hasFigmaToken": Keychain.load("figma") != nil,
                "hasCloudToken": Keychain.load("cloud") != nil,
                "outputFolder": outputFolder,
                "version": AppDelegate.version,
                "node": engine.node?.version ?? "",
                "nodePath": engine.node?.path ?? "",
            ], nil)
        case "setUnsplashKey":
            // An empty key removes the saved one. The engine restarts to pick it up.
            do {
                try Keychain.save(body["key"] as? String ?? "", account: "unsplash")
                replyHandler(true, nil)
                restartSoon()
            } catch { replyHandler(nil, error.localizedDescription) }
        case "setFigmaToken":
            // An empty token removes the saved one. No restart: the page hands the token to the
            // running engine itself (a restart would cut off an import under way); the engine gets
            // it as FIGMA_TOKEN when it next starts.
            do {
                try Keychain.save(body["key"] as? String ?? "", account: "figma")
                replyHandler(true, nil)
            } catch { replyHandler(nil, error.localizedDescription) }
        case "setCloudToken":
            // Collaboration session token: kept in Keychain so it survives restarts without restarting the engine now.
            do {
                try Keychain.save(body["key"] as? String ?? "", account: "cloud")
                replyHandler(true, nil)
            } catch { replyHandler(nil, error.localizedDescription) }
        case "chooseOutputFolder":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.prompt = "Use Folder"
            panel.message = "Imports and exports will be saved here."
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
            guard let path = body["path"] as? String, FileManager.default.fileExists(atPath: path) else { return replyHandler(nil, "The file isn't there any more.") }
            web.dragFile(URL(fileURLWithPath: path))
            replyHandler(true, nil)
        case "copyFile":
            guard let path = body["path"] as? String, FileManager.default.fileExists(atPath: path) else { return replyHandler(nil, "The file isn't there any more.") }
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
        case "choosePaths":
            // Files or folders for the page to import.
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = true
            panel.prompt = "Add"
            panel.message = body["message"] as? String ?? ""
            panel.beginSheetModal(for: window) { response in
                replyHandler(["paths": response == .OK ? panel.urls.map(\.path) : []], nil)
            }
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
        panel.message = "Choose Node.js (version 20 or newer), such as /opt/homebrew/bin/node."
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
        send([.data("pasted.png", png)])
    }

    /// A file for the engine: its bytes, or a file sent straight from disk.
    private enum Upload {
        case data(String, Data)
        case file(URL)
    }

    func upload(_ urls: [URL]) {
        // Figma files go to the page, which brings their frames in (onto this board, or a new one).
        let figs = urls.filter(StudioWebView.isFigFile)
        for url in figs { importFig(url) }
        let rest = urls.filter { !StudioWebView.isFigFile($0) }
        let takes = { (u: URL) in StudioWebView.importableTypes.contains { UTType(filenameExtension: u.pathExtension)?.conforms(to: $0) == true } }
        send(rest.filter(takes).map { .file($0) }, refused: rest.filter { !takes($0) }.map(\.lastPathComponent))
    }

    /// A .fig file (Figma's File › Save local copy), read off the main thread and handed to the page.
    private func importFig(_ url: URL) {
        Task {
            let data = await Task.detached(priority: .userInitiated) { try? Data(contentsOf: url) }.value
            guard let data else {
                _ = try? await web.callAsyncJavaScript("window.studio && window.studio.command('error', text)", arguments: ["text": "Couldn't open \(url.lastPathComponent): it isn't there any more, or \(AppName.name) isn't allowed to open it."], in: nil, contentWorld: .page)
                return
            }
            _ = try? await web.callAsyncJavaScript("window.studio && window.studio.command('importFigBytes', { name, data })", arguments: ["name": url.lastPathComponent, "data": data.base64EncodedString()], in: nil, contentWorld: .page)
        }
    }

    /// Off the main thread (a long video is gigabytes): each file goes to the engine, its answer
    /// ({path, poster?, width?, height?}) to the page as is; any that couldn't be added are named
    /// in a notice.
    private func send(_ uploads: [Upload], refused: [String] = []) {
        guard let base = engine.baseURL, !uploads.isEmpty || !refused.isEmpty else { return }
        Task {
            var items: [[String: Any]] = []
            var problems: [String] = []
            if !refused.isEmpty {
                problems.append("Couldn't add \(refused.joined(separator: ", ")). \(AppName.name) adds pictures (PNG, JPEG, WebP, TIFF, HEIC, SVG, GIF), videos (MP4, MOV) and Figma files (.fig).")
            }
            for upload in uploads {
                let name: String
                switch upload {
                case .data(let n, _): name = n
                case .file(let u): name = u.lastPathComponent
                }
                do { items.append(try await Self.post(upload, to: base)) } catch {
                    let why = error.localizedDescription
                    problems.append("Couldn't add \(name). \(why)\(why.hasSuffix(".") ? "" : ".")")
                }
            }
            if !items.isEmpty {
                let list = String(decoding: (try? JSONSerialization.data(withJSONObject: items)) ?? Data("[]".utf8), as: UTF8.self)
                _ = try? await web.evaluateJavaScript("window.studio && window.studio.command('imported', \(list))")
            }
            if !problems.isEmpty {
                _ = try? await web.callAsyncJavaScript("window.studio && window.studio.command('error', text)",
                                                       arguments: ["text": problems.joined(separator: " ")], contentWorld: .page)
            }
        }
    }

    private static func post(_ upload: Upload, to base: URL) async throws -> [String: Any] {
        var name: String
        var body: Upload = upload
        switch upload {
        case .data(let n, _): name = n
        case .file(let u):
            name = u.lastPathComponent
            guard FileManager.default.isReadableFile(atPath: u.path) else { throw ImportError("It isn't there any more, or Screenshotter isn't allowed to open it.") }
            // The engine takes PNG/JPEG/WebP: TIFF and HEIC are made PNG first, off the main thread.
            if ["tif", "tiff", "heic"].contains(u.pathExtension.lowercased()) {
                let png = try await Task.detached(priority: .userInitiated) { () throws -> Data in
                    guard let rep = NSImage(contentsOf: u).flatMap({ $0.tiffRepresentation }).flatMap(NSBitmapImageRep.init(data:)),
                          let png = rep.representation(using: .png, properties: [:]) else { throw ImportError("It isn't a picture Screenshotter can read.") }
                    return png
                }.value
                name = u.deletingPathExtension().lastPathComponent + ".png"
                body = .data(name, png)
            }
        }
        var components = URLComponents(url: base.appendingPathComponent("api/upload"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "name", value: name)]
        var req = URLRequest(url: components.url!)
        req.httpMethod = "POST"
        req.setValue("studio", forHTTPHeaderField: "x-screenshotter")
        let answer: Data
        switch body {
        case .data(_, let data): (answer, _) = try await URLSession.shared.upload(for: req, from: data)
        // Sent from the file as it's read: a video isn't loaded into memory first.
        case .file(let u): (answer, _) = try await URLSession.shared.upload(for: req, fromFile: u)
        }
        let json = (try? JSONSerialization.jsonObject(with: answer)) as? [String: Any]
        if let json, json["path"] is String { return json }
        throw ImportError(json?["error"] as? String ?? "The engine didn't take it. Try again.")
    }

    private struct ImportError: LocalizedError {
        let errorDescription: String?
        init(_ why: String) { errorDescription = why }
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
        panel.message = "Choose images or videos to add to the board."
        panel.beginSheetModal(for: window) { [weak self] r in if r == .OK { self?.upload(panel.urls) } }
    }
    @objc func revealOutput(_ sender: Any?) {
        let url = URL(fileURLWithPath: outputFolder)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.open(url)
    }
    @objc func restartEngine(_ sender: Any?) { startEngine() }
    @objc func showMainWindow(_ sender: Any?) { showStudio() }
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
        _ = submenu(AppName.name, [
            action("About \(AppName.name)", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            action("Check for Updates…", #selector(SPUStandardUpdaterController.checkForUpdates(_:)), target: updates),
            .separator(),
            item("Settings…", "settings", ","),
            .separator(),
            action("Hide \(AppName.name)", #selector(NSApplication.hide(_:)), "h"),
            action("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            action("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            action("Quit \(AppName.name)", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = submenu("File", [
            item("New Board", "newBoard", "n"),
            item("All Boards", "boards", "o", [.command, .shift]),
            item("Save", "save", "s"),
            .separator(),
            item("Import Website…", "importWebsite", "i", [.command, .shift]),
            item("Import from Figma…", "importFigma", "f", [.command, .shift]),
            action("Import Images…", #selector(openFilesPanel(_:)), "o", target: self),
            .separator(),
            item("Export Image", "exportImage", "e"),
            .separator(),
            action("Show Library in Finder", #selector(revealOutput(_:)), "", target: self),
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
            item("Use as Mask", "mask", "m", [.command, .control]),
        ])
        _ = submenu("View", [
            item("Zoom In", "zoomIn", "="),
            item("Zoom Out", "zoomOut", "-"),
            item("Zoom to Fit", "fit", "0"),
            .separator(),
            item("Show or Hide the Left Panel", "toggleLeft", "s", [.command, .option]),
            item("Show or Hide the Right Panel", "toggleRight", "i", [.command, .option]),
            item("Focus Mode", "focus", "\\"),
            .separator(),
            action("Reload Interface", #selector(reloadUI(_:)), "r", [.command, .option, .shift], target: self),
            action("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let win = submenu("Window", [
            action("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            action("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            action(AppName.name, #selector(showMainWindow(_:)), "", target: self),
        ])
        NSApp.windowsMenu = win
        let help = submenu("Help", [
            item("Chat with an Agent", "connect", "j"),
        ])
        NSApp.helpMenu = help
        NSApp.mainMenu = main
    }
}

/// The page shown while the engine starts, or when it can't.
enum StatusPage {
    static func html(for state: Engine.State, logPath: String) -> String {
        var title = "Starting \(AppName.name)"
        var body = "Warming up the engine…"
        var actions = ""
        var spinner = true
        if case .failed(let reason) = state {
            spinner = false
            if reason == "node" {
                title = "\(AppName.name) needs Node.js"
                body = "Install Node.js 20 or newer (from nodejs.org, or run <code>brew install node</code>), then try again. If it's already installed somewhere unusual, choose it."
                actions = "<button class='primary' onclick=\"post('restartEngine')\">Try again</button><button onclick=\"post('chooseNode')\">Choose Node.js…</button><button onclick=\"post('openURL',{url:'https://nodejs.org/en/download'})\">Get Node.js</button>"
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
