import XCTest
@testable import Screenshotter

final class CaptureUITests: XCTestCase {
    // The after-capture panel names the library by what the Studio calls it, never its folders.
    func testPlaceNamesAreFriendly() {
        let library = CaptureFiles(library: URL(fileURLWithPath: "/tmp/lib"))
        XCTAssertEqual(library.placeName(video: false), "in Screenshots")
        XCTAssertEqual(library.placeName(video: true), "in Recordings")
        XCTAssertEqual(CaptureFiles(library: library.library, destination: .desktop).placeName(video: true), "on your Desktop")
        XCTAssertEqual(CaptureFiles(library: library.library, destination: .folder, folder: "/Users/me/Client work").placeName(video: false), "in Client work")
    }

    // The thumbnail takes the capture's own shape inside the panel's box.
    func testThumbnailKeepsTheCapturesShape() {
        let box = CaptureHUDView.thumbBox
        let wide = CaptureHUDView.thumbSize(for: CGSize(width: 3000, height: 1000))
        XCTAssertEqual(wide.width, box.width)
        XCTAssertEqual(wide.height, (box.width / 3).rounded())
        let mac = CaptureHUDView.thumbSize(for: CGSize(width: 2560, height: 1600))
        XCTAssertEqual(mac.width / mac.height, 1.6, accuracy: 0.02)
        XCTAssertTrue(mac.width == box.width || mac.height == box.height)
        let tall = CaptureHUDView.thumbSize(for: CGSize(width: 1206, height: 2622))
        XCTAssertEqual(tall.height, box.height)
        XCTAssertLessThan(tall.width, box.width / 2)
        // A thin strip stays tall enough to grab.
        XCTAssertEqual(CaptureHUDView.thumbSize(for: CGSize(width: 4000, height: 40)).height, 48)
    }

    // One press on the pill's bin only asks; an immediate second press (a double click) doesn't answer.
    @MainActor func testDiscardAsksFirst() {
        let state = RecordingPill.State()
        XCTAssertFalse(state.confirmingDiscard)
        state.askToDiscard()
        XCTAssertTrue(state.confirmingDiscard)
        XCTAssertFalse(state.discardConfirmable)
        state.cancelDiscard()
        XCTAssertFalse(state.confirmingDiscard)
        XCTAssertFalse(state.discardConfirmable)
    }
}
