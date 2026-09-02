#!/usr/bin/env python3
"""Assemble the TaskDeck promo: stills + screencasts + Keita narration -> taskdeck_promo.mp4 (1920x1200, 30fps)."""
import json, os, subprocess, sys

P = "/private/tmp/claude-501/-Users-taiki-dev-taskdeck/0ae9834a-adce-4490-87e1-28ee9c7e8a19/scratchpad/promo"
SH, VO, OUT = f"{P}/shots", f"{P}/vo_keita", f"{P}/out"
os.makedirs(OUT, exist_ok=True)
FONT = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"
W, H, FPS = 1920, 1200, 30
GAP = 0.7
ACCENT = "#7c83ff"
BG = "#0b0d12"
# floating "terminal window" overlay geometry (covers the right side of the board)
TW, TH = 1267, 792
TX, TY = W - TW - 24, (H - TH) // 2

def sh(cmd):
    print("$", " ".join(cmd[:5]), "...", flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        print(r.stderr[-3000:]); sys.exit(1)
    return r

def dur(f):
    return float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]))

def esc(t):
    return t.replace("\\", "\\\\").replace("'", "\\'").replace(":", "\\:").replace(",", "\\,").replace("%", "%%")

def cap(text, a, b, size=50, y="h-150", box=True, color="white"):
    fade = f"if(lt(t\\,{a}+0.3)\\,(t-{a})/0.3\\,if(gt(t\\,{b}-0.3)\\,({b}-t)/0.3\\,1))"
    boxp = ":box=1:boxcolor=black@0.55:boxborderw=22" if box else ""
    return (f"drawtext=fontfile='{FONT}':text='{esc(text)}':fontsize={size}:fontcolor={color}"
            f":x=(w-text_w)/2:y={y}{boxp}:enable='between(t\\,{a}\\,{b})':alpha='{fade}'")

def zoom(n_frames, z0=1.0, z1=1.06):
    return (f"zoompan=z='{z0}+({z1}-{z0})*on/{n_frames}':d={n_frames}"
            f":x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={W}x{H}:fps={FPS}")

def win(src_label, t_in, t_out=None):
    """terminal window overlay stream: scaled, fades in at t_in (and out at t_out)."""
    f = f"[{src_label}]scale={TW}:{TH}:flags=lanczos,format=rgba,fade=t=in:st={t_in}:d=0.5:alpha=1"
    if t_out is not None:
        f += f",fade=t=out:st={t_out}:d=0.5:alpha=1"
    return f

def win_enable(t_in, t_out=None):
    return f"enable='gte(t\\,{t_in})'" if t_out is None else f"enable='between(t\\,{t_in}\\,{t_out + 0.5})'"

def cast_to_mp4(name):
    src, dst = f"{SH}/{name}/frames.txt", f"{OUT}/{name}.mp4"
    sh(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", src,
        "-vf", f"fps={FPS},scale={W}:{H}:flags=lanczos", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "16", dst])
    return dst

def marks(name):
    try:
        return json.load(open(f"{SH}/{name}/marks.json"))
    except Exception:
        return {}

def pop_sfx():
    f = f"{OUT}/pop.wav"
    if not os.path.exists(f):
        sh(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=1318:d=0.18",
            "-af", "afade=t=in:d=0.005,afade=t=out:st=0.05:d=0.13,volume=0.35,aformat=sample_rates=48000:channel_layouts=stereo", f])
    return f

def render_scene(idx, length, inputs, vfilter, vlabel, sfx_times=()):
    nar = f"{VO}/{idx:02d}.mp3"
    pop = pop_sfx()
    args = ["ffmpeg", "-y", "-loglevel", "error"]
    for i in inputs: args += i
    args += ["-i", nar]
    n_nar = len(inputs)
    for _ in sfx_times: args += ["-i", pop]
    af = f"[{n_nar}:a]volume=1.6,aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur={length}[na];"
    mix = "[na]"
    for k, t in enumerate(sfx_times):
        ms = int(t * 1000)
        af += f"[{n_nar + 1 + k}:a]adelay={ms}|{ms},aformat=sample_rates=48000:channel_layouts=stereo[s{k}];"
        mix += f"[s{k}]"
    if sfx_times:
        af += f"{mix}amix=inputs={1 + len(sfx_times)}:normalize=0:duration=first[amix];"
        alabel = "[amix]"
    else:
        alabel = "[na]"
    af += f"{alabel}atrim=0:{length},asetpts=PTS-STARTPTS[aout]"
    sf = f"{OUT}/scene{idx}.filter"
    open(sf, "w").write(vfilter + ";" + af)
    out = f"{OUT}/scene{idx}.mp4"
    args += ["-filter_complex_script", sf, "-map", vlabel, "-map", "[aout]", "-t", f"{length}",
             "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", out]
    sh(args)
    print(f"scene{idx}: {length:.1f}s -> {out}")
    return out

def render_video(name, length, inputs, vfilter, vlabel):
    """video-only clip (same encoding as scenes) so parts can be concatenated losslessly."""
    sf = f"{OUT}/{name}.filter"
    open(sf, "w").write(vfilter)
    out = f"{OUT}/{name}.mp4"
    args = ["ffmpeg", "-y", "-loglevel", "error"]
    for i in inputs: args += i
    args += ["-filter_complex_script", sf, "-map", vlabel, "-t", f"{length}", "-r", str(FPS),
             "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-an", out]
    sh(args)
    return out

def concat_files(name, files):
    lst = f"{OUT}/{name}.txt"
    open(lst, "w").write("".join(f"file '{f}'\n" for f in files))
    out = f"{OUT}/{name}.mp4"
    sh(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out])
    return out

def img(path):           # single-frame input (for zoompan)
    return ["-i", path]

def loop(path, length):  # looped still (for overlays that need a timeline)
    return ["-loop", "1", "-t", f"{length}", "-i", path]

def main():
    vo = [dur(f"{VO}/{i:02d}.mp3") for i in range(7)]
    print("narration:", [round(v, 1) for v in vo])
    scenes = []

    # ---- scene 0: hook. black + words, then the empty board fades in ----
    L = vo[0] + 1.0
    n = int(L * FPS) + 5
    vf = (f"[0:v]{zoom(n, 1.0, 1.05)},fade=t=in:st=4.6:d=1.2,"
          + cap("これやらなくちゃ", 0.2, 1.7, 88, "(h-text_h)/2", box=False) + ","
          + cap("あれもやらなくちゃ", 1.8, 3.4, 88, "(h-text_h)/2", box=False) + ","
          + cap("…そして、だいたい忘れる。", 3.6, 5.2, 72, "(h-text_h)/2", box=False) + ","
          + cap("taskdeck", 8.2, L, 60, "h-170", box=False, color=ACCENT) + "[v]")
    scenes.append(render_scene(0, L, [img(f"{SH}/00_hook_empty_board.png")], vf, "[v]"))

    # ---- scene 1: what it is. board push-in; a Claude Code window slides in over the right side ----
    L = vo[1] + GAP
    t_term = 12.0
    n = int(L * FPS) + 5
    vf = (f"[0:v]{zoom(n, 1.0, 1.025)}[a];"
          f"{win('1:v', t_term)}[w];"
          f"[a][w]overlay={TX}:{TY}:{win_enable(t_term)},"
          + cap("ローカル完結。データは自分の PC の中", 2.0, 9.5) + ","
          + cap("人間も Claude も、同じボードを見ている", t_term + 0.6, L - 0.3) + "[v]")
    scenes.append(render_scene(1, L, [img(f"{SH}/01_board_overview.png"), loop(f"{SH}/term_s1.png", L)], vf, "[v]"))

    # ---- scene 2: cards appear by themselves (highlight) ----
    L = vo[2] + GAP
    cast = cast_to_mp4("02_claude_adds_tasks")
    t_go = 9.0                      # Claude calls task_add here (terminal switches, cast starts)
    t_panel = t_go + 8.3            # cast clicks a card -> the detail panel opens on the right; hide the terminal
    vf = (f"[0:v]tpad=start_duration={t_go}:start_mode=clone,tpad=stop_mode=clone:stop_duration={L},fps={FPS},setpts=N/{FPS}/TB[b];"
          f"{win('1:v', 0.0, t_panel)}[w1];"
          f"{win('2:v', t_go, t_panel)}[w2];"
          f"[b][w1]overlay={TX}:{TY}:enable='lt(t\\,{t_go})'[b1];"
          f"[b1][w2]overlay={TX}:{TY}:{win_enable(t_go, t_panel)},"
          + cap("会話しているだけ", 1.0, t_go - 0.3) + ","
          + cap("ブラウザは触っていない。勝手に増える", t_go + 1.2, t_go + 7.8) + ","
          + cap("メモには理由と場所まで入っている", t_panel + 1.0, t_panel + 5.5) + ","
          + cap("頭の中に置いておかなくていい", 27.0, L - 0.3, 56) + "[v]")
    sfx = [t_go + 1.6, t_go + 3.4, t_go + 5.2]
    scenes.append(render_scene(2, L, [["-i", cast], loop(f"{SH}/term_s2a.png", L), loop(f"{SH}/term_s2.png", L)], vf, "[v]", sfx))

    # ---- scene 3: dispatch. cast slowed 1.35x up to "running", then hold ----
    L = vo[3] + GAP
    cast3 = cast_to_mp4("03_dispatch")
    m = marks("03_dispatch")
    t_dlg = m.get("03b_dispatch_modal", 4.2)
    t_cli = m.get("03c_dispatch_modal_headless", 7.5)
    t_run = m.get("03d_running", 11.5) + 1.2
    k = 1.35
    vf = (f"[0:v]trim=0:{t_run},setpts={k}*(PTS-STARTPTS),fps={FPS},settb=AVTB,format=yuv420p[a];"
          f"[1:v]scale={W}:{H}:flags=lanczos,fps={FPS},settb=AVTB,format=yuv420p[h];"
          f"[a][h]concat=n=2:v=1:a=0,setpts=N/{FPS}/TB,"
          + cap("カードのロボットボタンをポチッ", 0.8, (t_dlg - 0.6) * k) + ","
          + cap("作業フォルダは自動で入っている", (t_dlg + 0.2) * k, (t_cli - 0.4) * k) + ","
          + cap("デスクトップアプリで開く / バックグラウンドで実行", (t_cli + 0.2) * k, (t_run - 1.8) * k) + ","
          + cap("「実行中」バッジが付いたら、あとは待つだけ", t_run * k + 0.6, L - 0.3) + "[v]")
    scenes.append(render_scene(3, L, [["-i", cast3], loop(f"{SH}/03d_running.png", L)], vf, "[v]", [t_dlg * k - 0.15]))

    # ---- scene 4: progress moves by itself, run log, then "#12 やって" in a terminal window ----
    L = vo[4] + GAP
    t0 = t_run - 0.4
    end = m.get("end", dur(cast3))
    t_done = m.get("04a_done", 23.0) - t0
    t_log = m.get("04b_run_log", 26.0) - t0
    t_term = 13.0
    # pre-cut the cast segment (a trimmed stream confuses overlay timing, so cut it into its own file)
    seg = f"{OUT}/seg4.mp4"
    sh(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t0}", "-t", f"{end - t0}", "-i", cast3,
        "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", "-an", seg])
    # part A: cast segment + hold on the run-log still, captions
    vfA = (f"[0:v]fps={FPS},settb=AVTB,format=yuv420p[a];"
           f"[1:v]scale={W}:{H}:flags=lanczos,fps={FPS},settb=AVTB,format=yuv420p[h];"
           f"[a][h]concat=n=2:v=1:a=0,setpts=N/{FPS}/TB,"
           + cap("着手で Doing、完了で Done に勝手に動く", 0.8, t_done + 2.5) + ","
           + cap("実行ログがメモに残る", t_log + 0.3, t_term - 0.3) + "[v]")
    partA = render_video("scene4a", t_term, [["-i", seg], loop(f"{SH}/04b_run_log.png", L)], vfA, "[v]")
    # part B: still + terminal window fades in, caption
    LB = L - t_term
    n = int(LB * FPS) + 5
    vfB = (f"[0:v]{zoom(n, 1.0, 1.0)}[a];"
           f"{win('1:v', 0.3)}[w];"
           f"[a][w]overlay={TX}:{TY}:{win_enable(0.3)},"
           + cap("「#12 のタスクやって」の一言でOK", 0.9, LB) + "[v]")
    partB = render_video("scene4b", LB, [img(f"{SH}/04b_run_log.png"), loop(f"{SH}/term_s4.png", LB)], vfB, "[v]")
    v4 = concat_files("scene4v", [partA, partB])
    scenes.append(render_scene(4, L, [["-i", v4]], "[0:v]null[v]", "[v]", [t_done + 0.05]))

    # ---- scene 5: setup in 10 minutes ----
    L = vo[5] + GAP
    n = int(L * FPS) + 5
    t_win = 7.0
    vf = (f"[0:v]{zoom(n, 1.0, 1.04)}[a];"
          f"[1:v]scale=840:525:flags=lanczos,format=rgba,fade=t=in:st={t_win}:d=0.5:alpha=1[w];"
          f"[a][w]overlay={W - 840 - 40}:{H - 525 - 190}:enable='gte(t\\,{t_win})',"
          + cap("Mac でも Windows でも", 0.8, t_win - 0.3) + ","
          + cap("npm run mcp:register   これだけ", t_win + 0.3, L - 0.3, 56) + "[v]")
    scenes.append(render_scene(5, L, [img(f"{SH}/term_s5.png"), loop(f"{SH}/term_s5w.png", L)], vf, "[v]"))

    # ---- scene 6: closing + CTA ----
    L = vo[6] + GAP + 3.0
    n = int(L * FPS) + 5
    t_black = 8.5
    vf = (f"[0:v]{zoom(n, 1.0, 1.07)},fade=t=out:st={t_black - 1.0}:d=1.0,"
          + cap("覚えておく係は、Claude と TaskDeck に", t_black + 0.2, L, 66, "(h-text_h)/2-120", box=False) + ","
          + cap("taskdeck", t_black + 0.9, L, 54, "(h-text_h)/2+10", box=False, color=ACCENT) + ","
          + cap("セットアップガイド  docs/SETUP.md", t_black + 1.6, L, 40, "(h-text_h)/2+120", box=False) + ","
          + cap("質問は Slack #taskdeck へ", t_black + 2.0, L, 40, "(h-text_h)/2+190", box=False) + "[v]")
    scenes.append(render_scene(6, L, [img(f"{SH}/06_closing_board.png")], vf, "[v]"))

    # ---- concat ----
    lst = f"{OUT}/list.txt"
    open(lst, "w").write("".join(f"file '{s}'\n" for s in scenes))
    final = f"{OUT}/taskdeck_promo.mp4"
    sh(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", final])
    print("FINAL", final, f"{dur(final):.1f}s")

if __name__ == "__main__":
    main()
