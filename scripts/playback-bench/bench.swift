// WebKit video playback bench: WKWebView in a small floating window, like the LiveStage webviews.
// Usage: bench <pageURL> [views=1]
// The page posts JSON to `log`; {done:true} from every view ends the run.
import AppKit
import WebKit

final class AssetScheme: NSObject, WKURLSchemeHandler {
    // Mimics Tauri 2's asset protocol: async file read, one range response of at most 1000 KiB.
    let q = DispatchQueue(label: "asset", attributes: .concurrent)
    var stopped = Set<ObjectIdentifier>()
    let lock = NSLock()
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        let req = task.request
        let origin = pageOrigin
        q.async {
            let path = (req.url!.path as NSString).removingPercentEncoding ?? req.url!.path
            guard let fh = FileHandle(forReadingAtPath: path) else { return }
            let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? UInt64) ?? 0
            var start: UInt64 = 0
            var end: UInt64 = size - 1
            var status = 200
            if let r = req.value(forHTTPHeaderField: "Range"), r.hasPrefix("bytes=") {
                let parts = r.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
                if let s = UInt64(parts[0]) { start = s }
                if parts.count > 1, let e = UInt64(parts[1]) { end = min(e, size - 1) }
                status = 206
                end = start + min(end - start, min(size - start, 1000 * 1024) - 1)
            }
            try? fh.seek(toOffset: start)
            let data = fh.readData(ofLength: Int(end - start + 1))
            var headers = ["Content-Type": path.hasSuffix(".webm") ? "video/webm" : "video/mp4",
                           "Access-Control-Allow-Origin": origin,
                           "Content-Length": String(data.count)]
            if status == 206 {
                headers["Accept-Ranges"] = "bytes"
                headers["Content-Range"] = "bytes \(start)-\(end)/\(size)"
                headers["Access-Control-Expose-Headers"] = "content-range"
            }
            let resp = HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            // Answer on the main thread, where `stop` arrives, so a stopped task is never answered.
            DispatchQueue.main.async {
                if self.stopped.contains(id) { return }
                task.didReceive(resp)
                task.didReceive(data)
                task.didFinish()
            }
        }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }
}

final class Logger: NSObject, WKScriptMessageHandler {
    var done = 0
    let views: Int
    init(views: Int) { self.views = views }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        if let d = try? JSONSerialization.data(withJSONObject: m.body), let s = String(data: d, encoding: .utf8) {
            print(s); fflush(stdout)
        }
        if let b = m.body as? [String: Any], b["done"] as? Bool == true {
            done += 1
            if done >= views { NSApp.terminate(nil) }
        }
    }
}

let args = CommandLine.arguments
let page = args.count > 1 ? args[1] : "http://127.0.0.1:8765/bench.html"
let pageOrigin: String = {
    guard let u = URL(string: page), let s = u.scheme, let h = u.host else { return "http://127.0.0.1:8765" }
    return u.port.map { "\(s)://\(h):\($0)" } ?? "\(s)://\(h)"
}()
let views = args.count > 2 ? Int(args[2]) ?? 1 : 1
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let logger = Logger(views: views)
let scheme = AssetScheme()
let W: CGFloat = 360, Hh: CGFloat = 90
let win = NSWindow(contentRect: NSRect(x: 20, y: 40, width: W, height: Hh * CGFloat(views)), styleMask: [.titled], backing: .buffered, defer: false)
win.title = "LiveStage playback bench"
win.level = .statusBar
win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
var webviews: [WKWebView] = []
for i in 0..<views {
    let cfg = WKWebViewConfiguration()
    cfg.setURLSchemeHandler(scheme, forURLScheme: "asset")
    cfg.userContentController.add(logger, name: "log")
    cfg.mediaTypesRequiringUserActionForPlayback = []
    cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
    let wv = WKWebView(frame: NSRect(x: 0, y: Hh * CGFloat(i), width: W, height: Hh), configuration: cfg)
    let sep = page.contains("?") ? "&" : "?"
    wv.load(URLRequest(url: URL(string: page + sep + "view=\(i)")!))
    win.contentView!.addSubview(wv)
    webviews.append(wv)
}
win.orderFrontRegardless()
DispatchQueue.main.asyncAfter(deadline: .now() + 120) { print("{\"timeout\":true}"); NSApp.terminate(nil) }
app.run()
