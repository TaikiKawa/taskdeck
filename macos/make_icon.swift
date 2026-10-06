// AppIcon.icns 用の iconset PNG を生成する（main.swift の makeIcon と同じデザイン）。
// 見た目は alche-app-design の app/taskdeck.svg（地 #050505・白の横線 + イエローの進行中 1 本）に合わせている。
// 使い方: swift make_icon.swift <output.iconset>
//         swift make_icon.swift <outdir> --windows   # windows/taskdeck.ico 用の PNG (16..256, 余白を詰めた版) を出す
import AppKit

let args = CommandLine.arguments
guard args.count == 2 || (args.count == 3 && args[2] == "--windows") else {
    FileHandle.standardError.write("usage: swift make_icon.swift <output.iconset> [--windows]\n".data(using: .utf8)!)
    exit(1)
}
let outDir = URL(fileURLWithPath: args[1])
try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

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

func pngData(_ image: CGImage) -> Data {
    NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!
}

if args.count == 3 {
    for px in [16, 24, 32, 48, 64, 128, 256] {
        try pngData(renderIcon(px: px, crop: true)).write(to: outDir.appendingPathComponent("\(px).png"))
    }
    print("windows pngs written: \(outDir.path)")
    exit(0)
}

// iconset の標準構成 (base サイズと @2x)
let entries: [(String, Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]
for (name, px) in entries {
    try pngData(renderIcon(px: px)).write(to: outDir.appendingPathComponent(name))
}
print("iconset written: \(outDir.path)")
