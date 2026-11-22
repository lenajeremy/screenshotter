import XCTest
import UniformTypeIdentifiers
@testable import Screenshotter

final class ShellTests: XCTestCase {
    func testParsesEnvAfterMarkerAndIgnoresShellNoise() {
        let noise = "Last login: today\nwelcome banner\n"
        let payload = "\n\(ShellEnvironment.marker)\nPATH=/opt/homebrew/bin:/usr/bin\0ANTHROPIC_API_KEY=sk-test\0MULTI=a=b=c\0SCREENSHOTTER_RESOLVING_ENV=1\0"
        let env = ShellEnvironment.parse(Data((noise + payload).utf8))
        XCTAssertEqual(env["PATH"], "/opt/homebrew/bin:/usr/bin")
        XCTAssertEqual(env["ANTHROPIC_API_KEY"], "sk-test")
        XCTAssertEqual(env["MULTI"], "a=b=c")
        XCTAssertNil(env["SCREENSHOTTER_RESOLVING_ENV"])
        XCTAssertTrue(ShellEnvironment.parse(Data("no marker".utf8)).isEmpty)
    }

    func testNodeMajorVersion() {
        XCTAssertEqual(NodeLocator.major("v24.11.1\n"), 24)
        XCTAssertEqual(NodeLocator.major("20.0.0"), 20)
        XCTAssertNil(NodeLocator.major("node"))
    }

    func testNodeCandidatesKeepPathOrderWithoutDuplicates() {
        let list = NodeLocator.candidates(path: "/a/bin:/opt/homebrew/bin", home: "/Users/x")
        XCTAssertLessThan(list.firstIndex(of: "/a/bin/node")!, list.firstIndex(of: "/opt/homebrew/bin/node")!)
        XCTAssertEqual(list.filter { $0 == "/opt/homebrew/bin/node" }.count, 1)
    }

    func testEnginePortLine() {
        XCTAssertEqual(Engine.port(in: "Screenshotter Studio running at http://127.0.0.1:5123\nSCREENSHOTTER_STUDIO_PORT=5123\n"), 5123)
        XCTAssertNil(Engine.port(in: "starting…"))
    }

    func testFilePickerTakesWhatTheInputAccepts() throws {
        // A .fig on disk (whatever type the Mac gives it) can be chosen where the page asks for ".fig".
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let fig = dir.appendingPathComponent("Design.fig")
        try Data("fig-kiwi".utf8).write(to: fig)
        let type = try XCTUnwrap(fig.resourceValues(forKeys: [.contentTypeKey]).contentType)
        XCTAssertTrue(StudioWebView.contentTypes(forAccept: ".fig").contains { type.conforms(to: $0) }, "\(type.identifier) isn't taken for .fig")
        XCTAssertFalse(StudioWebView.contentTypes(forAccept: ".fig").contains { UTType.png.conforms(to: $0) })
        XCTAssertTrue(StudioWebView.contentTypes(forAccept: "image/*").contains { UTType.png.conforms(to: $0) })
        XCTAssertEqual(StudioWebView.contentTypes(forAccept: ""), StudioWebView.importableTypes + [.json])
        // The board's own picker for pictures and videos (MEDIA_ACCEPT in board.js).
        let media = StudioWebView.contentTypes(forAccept: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm")
        for t in [UTType.png, .jpeg, .webP, .gif, .svg, .mpeg4Movie, .quickTimeMovie] { XCTAssertTrue(media.contains { t.conforms(to: $0) }, "\(t.identifier) isn't taken") }
    }

    func testDragRegionsExcludeControls() {
        let r = DragRegions(regions: [CGRect(x: 0, y: 0, width: 1000, height: 52)], holes: [CGRect(x: 900, y: 10, width: 80, height: 32)])
        XCTAssertTrue(r.contains(CGPoint(x: 400, y: 20)))
        XCTAssertFalse(r.contains(CGPoint(x: 920, y: 20)))
        XCTAssertFalse(r.contains(CGPoint(x: 400, y: 80)))
        XCTAssertEqual(DragRegions.from([[1, 2, 3, 4], [5]]), [CGRect(x: 1, y: 2, width: 3, height: 4)])
    }
}
