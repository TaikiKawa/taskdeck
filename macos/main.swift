import Cocoa
import WebKit

@main
class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate {

    // メモ内リンク (target="_blank") は既定ブラウザで開く
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // JavaScript の confirm() / alert() をネイティブのダイアログで出す。
    // WKWebView は実装が無いと confirm() が常に false を返し、確認ダイアログが
    // 「キャンセル」扱いになる (全自動モードの確認やグループ削除の確認が通らない)。
    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "キャンセル")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    var window: NSWindow!
    var webView: WKWebView!
    var serverProcess: Process?
    let port = ProcessInfo.processInfo.environment["TASKDECK_PORT"] ?? "4747"
    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    // 配布版は Contents/Resources/app にソースと node_modules を同梱している。
    // 開発版 (macos/build.sh) は build 時に焼き込んだリポジトリパスを使う。
    var appRoot: String {
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("app").path,
           FileManager.default.fileExists(atPath: bundled + "/src/server.js") {
            return bundled
        }
        return repoPath
    }
    // 配布版に同梱した Node.js (scripts/package.mjs が app/node/bin/node に置く)
    var bundledNode: String? {
        let p = appRoot + "/node/bin/node"
        return FileManager.default.isExecutableFile(atPath: p) ? p : nil
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.applicationIconImage = makeIcon()
        buildMenu()

        let rect = NSRect(x: 0, y: 0, width: 1100, height: 720)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.title = "taskdeck"
        window.minSize = NSSize(width: 720, height: 420)
        window.setFrameAutosaveName("TaskdeckMain")
        window.center()
        // ページ読み込み前に白く光らないよう、窓の地を OS の明暗に合わせる (alche-app-design の bg: #141414 / #FFFFFF)
        let bg = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(srgbRed: 0x14 / 255, green: 0x14 / 255, blue: 0x14 / 255, alpha: 1)
                : NSColor.white
        }
        window.backgroundColor = bg

        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: rect, configuration: config)
        webView.uiDelegate = self
        webView.underPageBackgroundColor = bg
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        ensureServerThenLoad()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
    }

    // MARK: - Server lifecycle

    func ensureServerThenLoad() {
        ping { alive in
            if alive {
                DispatchQueue.main.async { self.webView.load(URLRequest(url: self.baseURL)) }
            } else {
                self.spawnServer()
                self.waitForServer(retries: 40)
            }
        }
    }

    func ping(_ completion: @escaping (Bool) -> Void) {
        var req = URLRequest(url: baseURL.appendingPathComponent("api/projects"))
        req.timeoutInterval = 0.5
        URLSession.shared.dataTask(with: req) { _, res, _ in
            completion((res as? HTTPURLResponse)?.statusCode == 200)
        }.resume()
    }

    func waitForServer(retries: Int) {
        ping { alive in
            DispatchQueue.main.async {
                if alive {
                    self.webView.load(URLRequest(url: self.baseURL))
                } else if retries > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        self.waitForServer(retries: retries - 1)
                    }
                } else {
                    self.showError("サーバーを起動できませんでした。\nnode と \(self.appRoot)/src/server.js を確認してください。")
                }
            }
        }
    }

    func spawnServer() {
        guard let node = findNode() else {
            showError("node が見つかりませんでした。Node.js をインストールしてください。")
            return
        }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = [appRoot + "/src/server.js"]
        proc.currentDirectoryURL = URL(fileURLWithPath: appRoot)
        var env = ProcessInfo.processInfo.environment
        env["TASKDECK_PORT"] = port
        proc.environment = env
        do {
            try proc.run()
            serverProcess = proc
        } catch {
            showError("サーバー起動に失敗: \(error.localizedDescription)")
        }
    }

    func findNode() -> String? {
        if let env = ProcessInfo.processInfo.environment["TASKDECK_NODE"],
           FileManager.default.isExecutableFile(atPath: env) { return env }
        if let bundled = bundledNode { return bundled }
        let home = NSHomeDirectory()
        let candidates = [
            home + "/.nodebrew/current/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ]
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return path
        }
        // Fall back to the login shell's PATH
        let sh = Process()
        sh.executableURL = URL(fileURLWithPath: "/bin/zsh")
        sh.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        sh.standardOutput = pipe
        try? sh.run()
        sh.waitUntilExit()
        let out = String(
            data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8
        )?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return out.isEmpty ? nil : out
    }

    func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "taskdeck"
        alert.informativeText = message
        alert.runModal()
    }

    // MARK: - Menu (Cmd+Q / Cmd+W / Cmd+R / copy-paste)

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "taskdeck を終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "編集")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "取り消す", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "やり直す", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "カット", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "コピー", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "ペースト", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "すべて選択", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "表示")
        viewItem.submenu = viewMenu
        viewMenu.addItem(withTitle: "再読み込み", action: #selector(reload), keyEquivalent: "r")

        let claudeItem = NSMenuItem()
        main.addItem(claudeItem)
        let claudeMenu = NSMenu(title: "Claude")
        claudeItem.submenu = claudeMenu
        claudeMenu.addItem(withTitle: "Claude Code に MCP を登録…", action: #selector(registerMcp), keyEquivalent: "")
        claudeMenu.addItem(withTitle: "MCP 登録コマンドをコピー", action: #selector(copyMcpCommand), keyEquivalent: "")

        let windowItem = NSMenuItem()
        main.addItem(windowItem)
        let windowMenu = NSMenu(title: "ウインドウ")
        windowItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "閉じる", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "しまう", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")

        NSApp.mainMenu = main
    }

    @objc func reload() {
        webView.load(URLRequest(url: baseURL))
    }

    // MARK: - MCP registration (配布版はターミナルで npm run mcp:register できないのでメニューから)

    func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    var mcpCommand: String {
        let node = bundledNode ?? findNode() ?? "node"
        let mcp = appRoot + "/src/mcp.js"
        return "claude mcp add --scope user taskdeck -- \(shellQuote(node)) \(shellQuote(mcp))"
    }

    func copyToPasteboard(_ s: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(s, forType: .string)
    }

    @objc func copyMcpCommand() {
        copyToPasteboard(mcpCommand)
        let alert = NSAlert()
        alert.messageText = "MCP 登録コマンドをコピーしました"
        alert.informativeText = "ターミナルに貼り付けて実行してください:\n\n\(mcpCommand)"
        alert.runModal()
    }

    @objc func registerMcp() {
        // ログインシェル経由で claude CLI を探す (.app は素の PATH しか持たない)
        let sh = Process()
        sh.executableURL = URL(fileURLWithPath: "/bin/zsh")
        sh.arguments = ["-lc", mcpCommand]
        let pipe = Pipe()
        sh.standardOutput = pipe
        sh.standardError = pipe
        do { try sh.run() } catch {
            copyToPasteboard(mcpCommand)
            showError("シェルを起動できませんでした。コマンドをクリップボードにコピーしたので、ターミナルで実行してください:\n\n\(mcpCommand)")
            return
        }
        sh.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let alert = NSAlert()
        alert.messageText = "taskdeck"
        if sh.terminationStatus == 0 {
            alert.informativeText = "Claude Code に MCP を登録しました。\n\n\(out)\n\n確認: claude mcp list"
        } else {
            copyToPasteboard(mcpCommand)
            alert.informativeText =
                "登録に失敗しました (claude CLI が見つからない可能性があります)。\n\n\(out)\n\n" +
                "コマンドをクリップボードにコピーしたので、ターミナルで実行してください:\n\(mcpCommand)"
        }
        alert.runModal()
    }

    // MARK: - Dock icon (drawn at runtime, no asset pipeline)

    // 見た目は macos/make_icon.swift・alche-app-design の app/taskdeck.svg と同じ。
    func makeIcon() -> NSImage {
        NSImage(cgImage: renderIcon(px: 1024), size: NSSize(width: 512, height: 512))
    }
}

// --- アイコン描画 (alche-app-design の app/taskdeck.svg と同じ。1024 グリッド・y 下向きの座標をそのまま使う) ---
// body / edge は SVG の path データそのもの（連続曲率の角丸）。M c L a Z だけを解釈する。
let iconBodyPath = "M627.36 100c103.83 0 155.75 0 195.41 20.21a185.4 185.4 0 0 1 81.02 81.02c20.21 39.66 20.21 91.58 20.21 195.41L924 627.36c0 103.83 0 155.75 -20.21 195.41a185.4 185.4 0 0 1 -81.02 81.02c-39.66 20.21 -91.58 20.21 -195.41 20.21L396.64 924c-103.83 0 -155.75 0 -195.41 -20.21a185.4 185.4 0 0 1 -81.02 -81.02c-20.21 -39.66 -20.21 -91.58 -20.21 -195.41L100 396.64c0 -103.83 0 -155.75 20.21 -195.41a185.4 185.4 0 0 1 81.02 -81.02c39.66 -20.21 91.58 -20.21 195.41 -20.21Z"
let iconEdgePath = "M630.36 105c101.03 0 151.55 0 190.14 19.66a180.4 180.4 0 0 1 78.84 78.84c19.66 38.59 19.66 89.11 19.66 190.14L919 630.36c0 101.03 0 151.55 -19.66 190.14a180.4 180.4 0 0 1 -78.84 78.84c-38.59 19.66 -89.11 19.66 -190.14 19.66L393.64 919c-101.03 0 -151.55 0 -190.14 -19.66a180.4 180.4 0 0 1 -78.84 -78.84c-19.66 -38.59 -19.66 -89.11 -19.66 -190.14L105 393.64c0 -101.03 0 -151.55 19.66 -190.14a180.4 180.4 0 0 1 78.84 -78.84c38.59 -19.66 89.11 -19.66 190.14 -19.66Z"

func iconPath(_ d: String) -> CGPath {
    let path = CGMutablePath()
    var tokens: [String] = []
    var cur = ""
    for ch in d {
        if ch.isLetter {
            if !cur.isEmpty { tokens.append(cur); cur = "" }
            tokens.append(String(ch))
        } else if ch == " " || ch == "," {
            if !cur.isEmpty { tokens.append(cur); cur = "" }
        } else if ch == "-" {
            if !cur.isEmpty { tokens.append(cur); cur = "" }
            cur = "-"
        } else { cur.append(ch) }
    }
    if !cur.isEmpty { tokens.append(cur) }
    var i = 0
    var p = CGPoint.zero
    func num() -> CGFloat { i += 1; return CGFloat(Double(tokens[i - 1])!) }
    while i < tokens.count {
        let cmd = tokens[i]; i += 1
        switch cmd {
        case "M": p = CGPoint(x: num(), y: num()); path.move(to: p)
        case "L": p = CGPoint(x: num(), y: num()); path.addLine(to: p)
        case "c":
            let c1 = CGPoint(x: p.x + num(), y: p.y + num())
            let c2 = CGPoint(x: p.x + num(), y: p.y + num())
            let q = CGPoint(x: p.x + num(), y: p.y + num())
            path.addCurve(to: q, control1: c1, control2: c2); p = q
        case "a": // 円弧 (rx=ry, sweep=1 = 画面上で時計回り の小さい弧)。3 次ベジェで近似
            let r = num(); _ = num(); _ = num(); _ = num(); _ = num()
            let q = CGPoint(x: p.x + num(), y: p.y + num())
            let dx = q.x - p.x, dy = q.y - p.y, d = (dx * dx + dy * dy).squareRoot()
            let h = (r * r - d * d / 4).squareRoot()
            let c = CGPoint(x: (p.x + q.x) / 2 - dy / d * h, y: (p.y + q.y) / 2 + dx / d * h)
            let a0 = atan2(p.y - c.y, p.x - c.x)
            var a1 = atan2(q.y - c.y, q.x - c.x)
            if a1 < a0 { a1 += 2 * .pi }
            let k = 4.0 / 3.0 * tan((a1 - a0) / 4) * r
            path.addCurve(
                to: q,
                control1: CGPoint(x: p.x - sin(a0) * k, y: p.y + cos(a0) * k),
                control2: CGPoint(x: q.x + sin(a1) * k, y: q.y - cos(a1) * k))
            p = q
        case "Z": path.closeSubpath()
        default: break
        }
    }
    return path
}

/// px 四方の CGImage にアイコンを描く。crop = true は Windows 用で、本体の外の余白を詰める（1024 → 864 の切り抜き）。
/// 32px 以下はグローを付けない（ぼけて汚く見えるため）。
func renderIcon(px: Int, crop: Bool = false) -> CGImage {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(
        data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let span: CGFloat = crop ? 864 : 1024
    let s = CGFloat(px) / span
    let o: CGFloat = crop ? 80 : 0
    ctx.translateBy(x: 0, y: CGFloat(px))
    ctx.scaleBy(x: s, y: -s) // y 下向き (SVG と同じ)
    ctx.translateBy(x: -o, y: -o)

    func color(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
        CGColor(
            colorSpace: cs,
            components: [
                CGFloat((hex >> 16) & 255) / 255, CGFloat((hex >> 8) & 255) / 255, CGFloat(hex & 255) / 255, a,
            ])!
    }

    let body = iconPath(iconBodyPath)
    ctx.addPath(body); ctx.setFillColor(color(0x050505)); ctx.fillPath()
    ctx.addPath(iconPath(iconEdgePath))
    ctx.setStrokeColor(color(0xFFFFFF, 0.09)); ctx.setLineWidth(10); ctx.strokePath()

    ctx.saveGState()
    ctx.addPath(body); ctx.clip()
    ctx.setLineWidth(56); ctx.setLineCap(.round); ctx.setLineJoin(.round)
    // 白の線 5 本 + 進行中のイエロー 1 本（中央列の上段）
    let white: [(CGFloat, CGFloat, CGFloat)] = [
        (314, 392, 378), (314, 512, 378), (314, 632, 378), (646, 392, 710), (646, 512, 710),
    ]
    let live: [(CGFloat, CGFloat, CGFloat)] = [(480, 392, 544)]
    func strokeLines(_ lines: [(CGFloat, CGFloat, CGFloat)], _ hex: UInt32) {
        ctx.setStrokeColor(color(hex))
        for (x1, y, x2) in lines { ctx.move(to: CGPoint(x: x1, y: y)); ctx.addLine(to: CGPoint(x: x2, y: y)) }
        ctx.strokePath()
    }
    // グロー: SVG の filter (stdDeviation 8 / 24、不透明度 0.5 / 0.28) の近似。setShadow の blur は端末座標で ≒ 2σ
    if px > 32 {
        for (sigma, alpha) in [(24.0, 0.28), (8.0, 0.5)] as [(CGFloat, CGFloat)] {
            for (lines, hex) in [(white, UInt32(0xFFFFFF)), (live, UInt32(0xD7FF00))] {
                ctx.setShadow(offset: .zero, blur: 2 * sigma * s, color: color(hex, alpha))
                strokeLines(lines, hex)
            }
        }
        ctx.setShadow(offset: .zero, blur: 0, color: nil)
    }
    strokeLines(white, 0xFFFFFF)
    strokeLines(live, 0xD7FF00)
    ctx.restoreGState()
    return ctx.makeImage()!
}
