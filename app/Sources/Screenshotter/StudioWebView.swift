import AppKit
import UniformTypeIdentifiers
import WebKit

/// Rectangles (in web-view points, top-left origin) where a click drags the window.
struct DragRegions: Equatable {
    var regions: [CGRect] = []
    var holes: [CGRect] = []

    func contains(_ p: CGPoint) -> Bool {
        regions.contains { $0.contains(p) } && !holes.contains { $0.insetBy(dx: -2, dy: -2).contains(p) }
    }

    /// `[[x, y, width, height], …]` from the page; numbers may arrive as ints or doubles.
    static func from(_ value: Any?) -> [CGRect] {
        (value as? [[Any]] ?? []).compactMap { a in
            let n = a.compactMap { ($0 as? NSNumber)?.doubleValue ?? ($0 as? Double) ?? ($0 as? Int).map(Double.init) }
            return n.count == 4 ? CGRect(x: n[0], y: n[1], width: n[2], height: n[3]) : nil
        }
    }
}

/// The web view that hosts the Studio. It adds what a browser tab can't do: drag the window from
/// the custom title bar, paste images from the clipboard, and drag exported files out.
final class StudioWebView: WKWebView, NSDraggingSource {
    var dragRegions = DragRegions()
    var onPasteImages: (() -> Void)?
    private(set) var lastMouseDown: NSEvent?

    private func webPoint(_ event: NSEvent) -> CGPoint {
        let p = convert(event.locationInWindow, from: nil)
        return isFlipped ? p : CGPoint(x: p.x, y: bounds.height - p.y)
    }

    override func mouseDown(with event: NSEvent) {
        lastMouseDown = event
        if dragRegions.contains(webPoint(event)) {
            if event.clickCount == 2 {
                let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
                if action == "Minimize" { window?.miniaturize(nil) } else if action != "None" { window?.zoom(nil) }
                return
            }
            window?.performDrag(with: event)
            return
        }
        super.mouseDown(with: event)
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // MARK: Right-click

    /// The page draws its own right-click menus; text fields keep the system's text menu. Trim
    /// that menu to text actions (cut, copy, paste, spelling, look up): items like Reload or
    /// Inspect Element belong to a browser, not to this app.
    static let browserMenuItems: Set<String> = [
        "WKMenuItemIdentifierReload", "WKMenuItemIdentifierInspectElement", "WKMenuItemIdentifierGoBack",
        "WKMenuItemIdentifierGoForward", "WKMenuItemIdentifierOpenLink", "WKMenuItemIdentifierOpenLinkInNewWindow",
        "WKMenuItemIdentifierDownloadLinkedFile", "WKMenuItemIdentifierCopyLink", "WKMenuItemIdentifierOpenImageInNewWindow",
        "WKMenuItemIdentifierDownloadImage", "WKMenuItemIdentifierCopyImage", "WKMenuItemIdentifierOpenFrameInNewWindow",
        "WKMenuItemIdentifierOpenMediaInNewWindow", "WKMenuItemIdentifierDownloadMedia", "WKMenuItemIdentifierShowHideMediaControls",
        "WKMenuItemIdentifierToggleFullScreen", "WKMenuItemIdentifierToggleEnhancedFullScreen", "WKMenuItemIdentifierShareMenu",
    ]

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        for item in menu.items where StudioWebView.browserMenuItems.contains(item.identifier?.rawValue ?? "") {
            menu.removeItem(item)
        }
        var lastWasSeparator = true
        for item in menu.items {
            if item.isSeparatorItem, lastWasSeparator { menu.removeItem(item) } else { lastWasSeparator = item.isSeparatorItem }
        }
        if menu.items.last?.isSeparatorItem == true { menu.removeItem(at: menu.items.count - 1) }
        super.willOpenMenu(menu, with: event)
    }

    // MARK: Paste

    // SVGs and GIFs come in as pictures for image blocks (logos, icons, stickers), the rest as screenshots.
    static let importableTypes: [UTType] = [.png, .jpeg, .webP, .tiff, .heic, .svg, .gif, .mpeg4Movie, .quickTimeMovie]

    static func pasteboardHasImport(_ pb: NSPasteboard = .general) -> Bool {
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
           urls.contains(where: { u in importableTypes.contains { UTType(filenameExtension: u.pathExtension)?.conforms(to: $0) == true } }) {
            return true
        }
        return pb.availableType(from: [.png, .tiff]) != nil
    }

    private static let pasteSelector = NSSelectorFromString("paste:")

    /// WebKit implements `paste:` in Objective-C without exposing it to Swift, so this takes over
    /// the selector and calls WebKit's own version for ordinary text pastes.
    @objc(paste:) func pasteFromMenu(_ sender: Any?) {
        guard StudioWebView.pasteboardHasImport() else { return webKitPaste(sender) }
        // Text fields keep normal paste; anywhere else an image becomes a new screenshot.
        evaluateJavaScript("Boolean(window.studio && window.studio.isTyping())") { [weak self] result, _ in
            guard let self else { return }
            if (result as? Bool) == true, NSPasteboard.general.string(forType: .string) != nil {
                self.webKitPaste(sender)
            } else {
                self.onPasteImages?()
            }
        }
    }

    private func webKitPaste(_ sender: Any?) {
        guard let imp = class_getMethodImplementation(WKWebView.self, StudioWebView.pasteSelector) else { return }
        typealias Paste = @convention(c) (AnyObject, Selector, Any?) -> Void
        unsafeBitCast(imp, to: Paste.self)(self, StudioWebView.pasteSelector, sender)
    }

    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == StudioWebView.pasteSelector, StudioWebView.pasteboardHasImport() { return true }
        return super.validateUserInterfaceItem(item)
    }

    // MARK: Drag a file out (Finder, Slack, Figma…)

    func dragFile(_ url: URL) {
        guard let event = lastMouseDown ?? NSApp.currentEvent else { return }
        let item = NSDraggingItem(pasteboardWriter: url as NSURL)
        let image = NSImage(contentsOf: url).map { img -> NSImage in
            let maxEdge: CGFloat = 160
            let s = min(maxEdge / max(img.size.width, 1), maxEdge / max(img.size.height, 1))
            let size = NSSize(width: img.size.width * s, height: img.size.height * s)
            return NSImage(size: size, flipped: false) { rect in
                img.draw(in: rect)
                return true
            }
        } ?? NSWorkspace.shared.icon(forFile: url.path)
        let p = convert(event.locationInWindow, from: nil)
        item.setDraggingFrame(NSRect(x: p.x - image.size.width / 2, y: p.y - image.size.height / 2, width: image.size.width, height: image.size.height), contents: image)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        context == .outsideApplication ? .copy : []
    }
}

/// The main window: dark, no visible title bar, traffic lights centred in the web UI's top bar.
final class StudioWindow: NSWindow {
    static let topBarHeight: CGFloat = 52

    /// The window numbers of the Studio windows showing now: captures keep these, and leave out
    /// the rest of the app (the capture bar, pickers, pill, bubble and panels).
    @MainActor static func visibleIDs() -> Set<CGWindowID> {
        Set(NSApp.windows.compactMap { $0 is StudioWindow && $0.isVisible && $0.windowNumber > 0 ? CGWindowID($0.windowNumber) : nil })
    }

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 1360, height: 880),
                   styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                   backing: .buffered, defer: false)
        titlebarAppearsTransparent = true
        titleVisibility = .hidden
        title = "Screenshotter"
        backgroundColor = NSColor(red: 0.043, green: 0.043, blue: 0.051, alpha: 1)
        appearance = NSAppearance(named: .darkAqua)
        minSize = NSSize(width: 1040, height: 660)
        isReleasedWhenClosed = false
        tabbingMode = .disallowed
        collectionBehavior.insert(.fullScreenPrimary)
        setFrameAutosaveName("StudioWindow")
        if !setFrameUsingName("StudioWindow") { center() }
    }

    /// Move the close/minimise/zoom buttons down so they sit in the middle of the 52pt top bar.
    ///
    /// The title bar container is stretched to end just below the buttons and the buttons sit at
    /// its bottom edge (the approach Electron and Tauri use). If AppKit later resets the
    /// container's height, the buttons stay visible, just a little higher.
    func layoutTrafficLights() {
        guard let close = standardWindowButton(.closeButton), let container = close.superview?.superview else { return }
        if styleMask.contains(.fullScreen) { return }
        let buttonHeight = close.frame.height
        let top = ((StudioWindow.topBarHeight - buttonHeight) / 2).rounded()
        var frame = container.frame
        frame.size.height = buttonHeight + top
        frame.origin.y = self.frame.height - frame.size.height
        container.frame = frame
        let buttons = [close, standardWindowButton(.miniaturizeButton), standardWindowButton(.zoomButton)].compactMap { $0 }
        for (i, b) in buttons.enumerated() {
            b.setFrameOrigin(NSPoint(x: 20 + CGFloat(i) * 20, y: 0))
        }
    }
}
