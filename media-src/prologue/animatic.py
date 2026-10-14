#!/usr/bin/env python3
"""Render a prologue animatic (P1–P4 up to Goliath's fall) with the voiceover mix and SFX.

Pictures come from public/media/prologue (what the show plays), framed as the
32:9 wall sees them. Audio is the no-stage-directions prologue mix from the
script project (read only), with gaps opened where stage action needs time.

    python3 media-src/prologue/animatic.py   ->  renders/prologue-animatic.mp4
"""
import os, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
M = os.path.join(ROOT, "public/media/prologue")
SFX = os.path.join(ROOT, "media-src/prologue/sfx")
MIX = "/Users/emmanuelcrown/Documents/Videos/Salvation/Script/audiobook/output/no-directions/chapters/01-PROLOGUE-ONCE-UPON-A-TIME-THERE-WAS-A-SHEPHERD.mp3"
OUT = os.path.join(ROOT, "renders")
TMP = os.path.join(OUT, "tmp")
os.makedirs(TMP, exist_ok=True)

W, H, FH = 1920, 540, 822  # wall frame; full 21:9 frame height at 1920 wide
FPS = 24
ENC = ["-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", str(FPS), "-an"]
VP9 = ["-c:v", "libvpx-vp9"]

# ---- timeline (seconds on the animatic) ----
T_TIMELAPSE = 48.5           # during "He'd write that down one day…"
T_P2 = T_TIMELAPSE + 10.04   # lands on "Then one day… a lion came"
T_CHARGE = 66.0
T_DARK = T_CHARGE + 4.75     # lights out on the lion's face
T_P3 = 72.5                  # lights up for "The lion lost."
T_SKY = 79.44                # on "And the boy grew."
T_P4 = T_SKY + 14.08
T_GOLIATH = 97.0             # "…their champion walked into the valley"
T_THUD = 141.17              # stone hits (the mix's THUD)
FLIGHT = 0.55
T_FALL = T_THUD
T_SHIELD = T_FALL + 2.05
T_QUAKE = T_FALL + 5.85
T_END = 151.0

def anchor_y(a):
    return round(a * (FH - H))

def run(args):
    print(" ".join(a if " " not in a else repr(a) for a in args[:6]), "…", file=sys.stderr)
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)

def fit(a):  # scale a 21:9 clip to the 1920-wide frame, crop to the wall at anchor a
    return f"scale={W}:{FH},setsar=1,crop={W}:{H}:0:{anchor_y(a)}"

def glide(a0, a1, dur):  # crop that moves vertical framing from a0 to a1 (smoothstep)
    y0, y1 = anchor_y(a0), anchor_y(a1)
    s = f"(3*pow(min(t/{dur},1),2)-2*pow(min(t/{dur},1),3))"
    return f"scale={W}:{FH},setsar=1,crop={W}:{H}:0:'{y0}+({y1 - y0})*{s}'"

segs = []

# S1 push-in
run(["-i", f"{M}/p1-push-in.mp4", "-vf", fit(0.35), *ENC, f"{TMP}/s1.mp4"]); segs.append("s1")

# S2 field loop + cut-out flock
d = T_TIMELAPSE - 8.04
run(["-stream_loop", "-1", "-i", f"{M}/p1-fields-loop.mp4", "-stream_loop", "-1", *VP9, "-i", f"{M}/p1-sheep-cutout.webm",
     "-filter_complex", f"[0:v]scale={W}:{FH},setsar=1[bg];[1:v]scale={W}:{FH},format=yuva420p[sh];[bg][sh]overlay=0:0,crop={W}:{H}:0:{anchor_y(0.35)}",
     "-t", f"{d:.3f}", *ENC, f"{TMP}/s2.mp4"]); segs.append("s2")

# S3 time-lapse travel (framing glides from P1 to P2)
run(["-i", f"{M}/p1-to-p2-timelapse.mp4", "-vf", glide(0.35, 0.05, 10.04), *ENC, f"{TMP}/s3.mp4"]); segs.append("s3")

# S4 lion: climb, watch, charge, lights out
idle = T_CHARGE - (T_P2 + 6.04)
dark_at = T_DARK - T_P2
s4_len = T_P3 - T_P2
run(["-i", f"{M}/p2-lion-climb.mp4", "-i", f"{M}/p2-lion-idle.mp4", "-i", f"{M}/p2-lion-charge.mp4",
     "-filter_complex",
     f"[1:v]trim=duration={idle:.3f},setpts=PTS-STARTPTS[i];[0:v][i][2:v]concat=n=3:v=1,{fit(0.05)},"
     f"tpad=stop_mode=clone:stop_duration=5,fade=out:st={dark_at:.3f}:d=0.12,trim=duration={s4_len:.3f}",
     *ENC, f"{TMP}/s4.mp4"]); segs.append("s4")

# S5 lights up on David on the lion
run(["-stream_loop", "-1", "-i", f"{M}/p3-david-lion-loop.mp4", "-vf", f"{fit(0.42)},fade=in:st=0:d=2.5", "-t", f"{T_SKY - T_P3:.3f}", *ENC, f"{TMP}/s5.mp4"]); segs.append("s5")

# S6 sky travel (P3 → P4 framing)
run(["-i", f"{M}/p3-to-p4-sky.mp4", "-vf", glide(0.42, 0.5, 14.08), *ENC, f"{TMP}/s6.mp4"]); segs.append("s6")

# S7 Valley of Elah: battlefield loop + Goliath (enter, taunt loop, fall, hold) + stone + shakes
p4 = T_END - T_P4
g_in = T_GOLIATH - T_P4
taunt = T_FALL - (T_GOLIATH + 6.04)
gw, gh = round(W * 0.73), round(FH * 0.73)
gx = round(W * 0.565 - 0.565 * gw)              # pivot x stays on 0.565
gy = round(FH * (0.9 - 0.08) - 0.9 * gh)         # feet at 0.82 of the frame
stone = f"{TMP}/stone.png"
flash = f"{TMP}/flash.png"
subprocess.run([sys.executable, "-c", f"""
from PIL import Image, ImageDraw, ImageFilter
def glow(path, size, core):
    im = Image.new('RGBA', (size, size), (0,0,0,0)); d = ImageDraw.Draw(im); c = size/2
    for r in range(int(c), 0, -1):
        a = int(255 * (1 - r/c) ** 2.2); d.ellipse([c-r, c-r, c+r, c+r], fill=(255, 236, 200, a))
    if core:
        d.ellipse([c-core, c-core, c+core, c+core], fill=(200, 188, 168, 255)); d.ellipse([c-core*0.55, c-core*0.75, c+core*0.2, c], fill=(250, 244, 230, 255))
    im.save(path)
glow('{stone}', 64, 9); glow('{flash}', 220, 0)
"""], check=True)
k = f"((t-{T_THUD - FLIGHT - T_P4:.3f})/{FLIGHT})"
fx, fy, cx, cy, tx, ty = 0.02 * W, 0.95 * H, 0.2875 * W, 0.42 * H, 0.555 * W, 0.09 * H
bx = f"(pow(1-{k},2)*{fx}+2*(1-{k})*{k}*{cx}+pow({k},2)*{tx})"
by = f"(pow(1-{k},2)*{fy}+2*(1-{k})*{k}*{cy}+pow({k},2)*{ty})"
ts, te = T_THUD - FLIGHT - T_P4, T_THUD - T_P4

def shake(axis):
    out = []
    for at, dur, amp, f in [(T_SHIELD - T_P4, 0.7, 0.012 * H, 16), (T_QUAKE - T_P4, 2.8, 0.06 * H, 9)]:
        w = 6.2832 * f * (1.21 if axis == "y" else 1)
        out.append(f"if(between(t,{at:.3f},{at + dur:.3f}),{amp:.2f}*pow(1-(t-{at:.3f})/{dur},2)*(0.6*sin({w:.3f}*(t-{at:.3f}))+0.4*sin({w * 1.73:.3f}*(t-{at:.3f}))),0)")
    return "+".join(out)

run(["-stream_loop", "-1", "-i", f"{M}/p4-battlefield-loop.mp4",
     *VP9, "-i", f"{M}/p4-goliath-enter-cutout.webm",
     "-stream_loop", "-1", *VP9, "-i", f"{M}/p4-goliath-taunt-cutout.webm",
     *VP9, "-i", f"{M}/p4-goliath-fall-cutout.webm",
     "-loop", "1", "-i", stone, "-loop", "1", "-i", flash,
     "-filter_complex",
     f"[2:v]trim=duration={taunt:.3f},setpts=PTS-STARTPTS[ta];"
     f"[1:v][ta][3:v]concat=n=3:v=1,format=yuva420p,tpad=stop_mode=clone:stop_duration=30,scale={gw}:{gh},setpts=PTS-STARTPTS+{g_in:.3f}/TB[g];"
     f"[0:v]scale={W}:{FH},setsar=1[bg];[bg][g]overlay={gx}:{gy}:eof_action=pass,crop={W}:{H}:0:{anchor_y(0.5)}[p];"
     f"[p][4:v]overlay=x='{bx}-32':y='{by}-32':enable='between(t,{ts:.3f},{te:.3f})'[s];"
     f"[5:v]format=rgba,fade=out:st=0:d=0.35:alpha=1,setpts=PTS-STARTPTS+{te:.3f}/TB[fl];"
     f"[s][fl]overlay=x={tx - 110:.0f}:y={ty - 110:.0f}:enable='between(t,{te:.3f},{te + 0.35:.3f})'[s2];"
     f"[s2]split[a][b];[a]scale={round(W * 1.12)}:{round(H * 1.12)},crop={W}:{H}[z];"
     f"[z][b]overlay=x='{shake('x')}':y='{shake('y')}',fade=out:st={p4 - 1.5:.3f}:d=1.5",
     "-t", f"{p4:.3f}", *ENC, f"{TMP}/s7.mp4"]); segs.append("s7")

# concat pictures
with open(f"{TMP}/list.txt", "w") as fh:
    fh.writelines(f"file '{TMP}/{s}.mp4'\n" for s in segs)
run(["-f", "concat", "-safe", "0", "-i", f"{TMP}/list.txt", "-c", "copy", f"{TMP}/picture.mp4"])

# ---- audio ----
def at(path, start, vol=1.0, loop=False, dur=None, src=None, fin=0, fout=0):
    return dict(path=path, start=start, vol=vol, loop=loop, dur=dur, src=src, fin=fin, fout=fout)

cues = [
    at(MIX, 0.0, src=(0.0, 61.9), fout=0.3),
    at(MIX, T_P3 + 0.34, src=(63.4, 71.85), fout=0.2),          # "The lion lost." … "And the boy grew."
    at(MIX, 90.94, src=(71.85, 123.2), fout=0.25),               # "Years later…" → Goliath, David, sling, THUD
    at(f"{M}/../prologue/p1-sheep-cutout.webm", 8.04, 0.35, loop=True, dur=T_TIMELAPSE + 6 - 8.04, fin=1.5, fout=6),
    at(f"{SFX}/night.mp3", T_TIMELAPSE + 6, 0.35, loop=True, dur=T_P4 - T_TIMELAPSE - 4, fin=3, fout=3),
    at(f"{SFX}/lion-charge.mp3", T_CHARGE, 1.0),
    at(f"{SFX}/battlefield.mp3", T_P4 - 6, 0.4, loop=True, dur=T_END - T_P4 + 6, fin=4, fout=2),
    at(f"{SFX}/footsteps.mp3", T_GOLIATH, 0.9),
    at(f"{SFX}/shield.mp3", T_SHIELD - 0.1, 0.9),
    at(f"{SFX}/fall.mp3", T_QUAKE - 0.1, 1.0),
]
args, chains = [], []
for i, c in enumerate(cues):
    if c["loop"]:
        args += ["-stream_loop", "-1"]
    if c["src"]:
        args += ["-ss", str(c["src"][0]), "-t", f"{c['src'][1] - c['src'][0]:.3f}"]
    args += ["-i", c["path"]]
    f = [f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo"]
    if c["dur"]:
        f.append(f"atrim=duration={c['dur']:.3f}")
    length = c["dur"] or (c["src"][1] - c["src"][0] if c["src"] else None)
    if c["fin"]:
        f.append(f"afade=in:d={c['fin']}")
    if c["fout"] and length:
        f.append(f"afade=out:st={length - c['fout']:.3f}:d={c['fout']}")
    f.append(f"volume={c['vol']},adelay={int(c['start'] * 1000)}:all=1[a{i}]")
    chains.append(",".join(f))
mix = ";".join(chains) + ";" + "".join(f"[a{i}]" for i in range(len(cues))) + f"amix=inputs={len(cues)}:normalize=0:duration=longest,atrim=duration={T_END},alimiter=limit=0.95[out]"
run([*args, "-filter_complex", mix, "-map", "[out]", "-c:a", "pcm_s16le", f"{TMP}/audio.wav"])

final = os.path.join(OUT, "prologue-animatic.mp4")
run(["-i", f"{TMP}/picture.mp4", "-i", f"{TMP}/audio.wav", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", final])
print(final)
