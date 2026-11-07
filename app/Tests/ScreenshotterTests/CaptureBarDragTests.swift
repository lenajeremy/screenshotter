import AppKit
import SwiftUI
import XCTest
@testable import Screenshotter

/// The capture bar moves when dragged by its grip, its gaps or its edges, and its buttons still
/// take their clicks: asked which view each point lands on, as a click would be.
@MainActor final class CaptureBarDragTests: XCTestCase {
    func testGripAndGapsDragButButtonsClick() throws {
        let scratch = UserDefaults(suiteName: "capture-bar-drag-test")!
        scratch.removePersistentDomain(forName: "capture-bar-drag-test")
        let model = CaptureModel(defaults: scratch)
        let actions = CaptureBarActions(capture: {}, openStudio: {}, close: {}, resized: {}, chooseFolder: {})
        let host = NSHostingView(rootView: CaptureBarView(model: model, actions: actions))
        let size = host.fittingSize
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        host.frame = CGRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
        let midY = size.height / 2
        func lands(_ x: CGFloat, _ y: CGFloat? = nil) -> Bool {
            host.hitTest(CGPoint(x: x, y: y ?? midY)) is WindowGrip.GripView
        }
        // The grip at the left, and the bar's top and bottom edges, drag it.
        XCTAssertTrue(lands(9), "the grip drags the bar")
        XCTAssertTrue(lands(size.width / 2, 3), "the top edge drags the bar")
        XCTAssertTrue(lands(size.width / 2, size.height - 3), "the bottom edge drags the bar")
        // The close button (just right of the grip) and the capture button (the end) don't.
        XCTAssertFalse(lands(36), "the close button takes its click")
        XCTAssertFalse(lands(size.width - 60), "the capture button takes its click")
    }

    // Where it was moved to comes back the next time, kept on the screen.
    func testKeptOnScreen() {
        let v = CGRect(x: 0, y: 0, width: 1000, height: 800)
        XCTAssertEqual(CaptureBarPanel.kept(CGRect(x: -200, y: 900, width: 400, height: 46), in: v).origin, CGPoint(x: 8, y: 746))
        XCTAssertEqual(CaptureBarPanel.kept(CGRect(x: 300, y: 100, width: 400, height: 46), in: v).origin, CGPoint(x: 300, y: 100))
    }
}
