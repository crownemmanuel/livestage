#!/usr/bin/env python3
"""Video generation harness: Seedance on KreatorFlow, Kling 3.0 and Topaz upscale on Kie.ai.

Default: Seedance 2.0 Fast at 720p on KreatorFlow (about $0.84 per 10 s), then `upscale` 2x with
Topaz on Kie.ai for the wall. Every run writes its job JSON next to the output and a line in the
folder's prompts.jsonl (genlog), so `genlog.py find` can trace it.

Keys live in the repo-root .env (git-ignored): KREATORFLOW_API_KEY and KIE_API_KEY.

    # draft a clip (Seedance 2.0 Fast, 720p, 21:9, 10 s), first/last frames from local files
    python3 media-src/tools/gen.py video media-src/scene1/bg01-hd --out left-palm.mp4 \
        --prompt-file left-palm.txt --first start.png --last end.png --scenes 2.1 --status draft

    # same clip on Kling 3.0 (Kie.ai). Kling has no 21:9: pass 16:9 frames, or let it follow the frame
    python3 media-src/tools/gen.py video media-src/scene1/bg01-hd --model kling --out left-palm-kling.mp4 ...

    # upscale an approved clip 2x with Topaz (Kie.ai), writes left-palm-2x.mp4
    python3 media-src/tools/gen.py upscale media-src/scene1/bg01-hd --in left-palm.mp4 --scenes 2.1

    python3 media-src/tools/gen.py status kreatorflow <job id>      # poll a job again
    python3 media-src/tools/gen.py models                           # KreatorFlow model list (durations, limits)
    python3 media-src/tools/gen.py video ... --dry-run              # print the request and the price, send nothing

Models (--model): fast (default, Seedance 2.0 Fast), mini, seedance (2.0), seedance-2.5, kling (3.0 std),
kling-pro, kling-4k. Resolutions 480p/720p/1080p/4k where the model has them. --audio asks the model for sound.
"""
import argparse
import base64
import datetime
import json
import mimetypes
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GENLOG = ROOT / "media-src" / "tools" / "genlog.py"

KREATORFLOW = "https://kreatorflow.ai/v1"
KIE = "https://api.kie.ai/api/v1"
KIE_UPLOAD = "https://kieai.redpandaai.co/api"

# alias -> (provider, provider model id, USD per second by resolution, max seconds)
MODELS = {
    "fast": ("kreatorflow", "kreator-video-fast", {"480p": 0.058, "720p": 0.084, "1080p": 0.183}, 10),
    "mini": ("kreatorflow", "kreator-video-mini", {"480p": 0.058, "720p": 0.067, "1080p": 0.135}, 10),
    "seedance": ("kreatorflow", "kreator-video-pro", {"480p": 0.076, "720p": 0.110, "1080p": 0.240, "4k": 0.580}, 15),
    "seedance-2.5": ("kreatorflow", "kreator-video-seedance-2-5", {"480p": 0.143, "720p": 0.207, "1080p": 0.444, "4k": 0.999}, 30),
    # Kie.ai Kling 3.0: $0.70 per 10 s without sound, $1.00 with (user-quoted, 2026-10-28); mode picks the size
    "kling": ("kie", "std", {"720p": 0.07}, 15),
    "kling-pro": ("kie", "pro", {"1080p": 0.07}, 15),
    "kling-4k": ("kie", "4K", {"4k": 0.07}, 15),
}
KLING_SOUND_PER_SEC = 0.10
KLING_RES = {"std": "720p", "pro": "1080p", "4K": "4k"}


def env():
    """Read the repo-root .env (KEY=value lines) into os.environ without overriding the shell."""
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def key(name):
    v = os.environ.get(name)
    if not v:
        sys.exit(f"{name} is not set: add it to {ROOT / '.env'} (see .env.example)")
    return v


def http(method, url, token, body=None, headers=None, raw=None, timeout=120):
    h = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        raw = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(url, data=raw, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {url} -> HTTP {e.code}: {e.read().decode(errors='replace')[:800]}")
    if not data:
        return {}
    try:
        return json.loads(data)
    except ValueError:
        return {"raw": data.decode(errors="replace")}


def download(url, dest, token=None):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"} if token else {})
    with urllib.request.urlopen(req, timeout=600) as r, open(dest, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    return dest


def probe_seconds(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True, check=True).stdout.strip()
        return float(out)
    except Exception:
        return None


# ---------------------------------------------------------------- KreatorFlow (Seedance)

def kf_upload(path, token):
    """Create upload -> PUT bytes -> complete. Returns the upload id."""
    path = Path(path)
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    kind = "VIDEO" if mime.startswith("video/") else "AUDIO" if mime.startswith("audio/") else "IMAGE"
    created = http("POST", f"{KREATORFLOW}/uploads", token,
                   {"file_name": path.name, "mime_type": mime, "file_size": path.stat().st_size, "upload_type": kind})
    d = created.get("data", created)
    up = d.get("upload") or d
    put_url = up.get("direct_upload_url") or up.get("directUploadUrl")
    upload_id = up.get("upload_id") or up.get("id")
    if not (put_url and upload_id):
        sys.exit(f"unexpected upload response (check the field names against the KreatorFlow reference):\n{json.dumps(created, indent=1)[:1500]}")
    put_headers = up.get("headers") or up.get("upload_headers") or {"Content-Type": mime}
    req = urllib.request.Request(put_url, data=path.read_bytes(), method="PUT", headers=put_headers)
    with urllib.request.urlopen(req, timeout=600) as r:
        r.read()
    http("POST", f"{KREATORFLOW}/uploads/complete", token, {"upload_id": upload_id})
    return upload_id


def kf_create(a, model_id, token):
    body = {"model": model_id, "prompt": a.prompt, "duration": a.duration, "aspect_ratio": a.ratio,
            "resolution": a.res, "generate_audio": bool(a.audio)}
    if a.seed is not None:
        body["seed"] = a.seed
    if a.first:
        body["first_frame_upload_id"] = kf_upload(a.first, token)
    if a.last:
        body["last_frame_upload_id"] = kf_upload(a.last, token)
    if a.ref:
        body["reference_image_upload_ids"] = [kf_upload(r, token) for r in a.ref]
    if a.ref_video:
        body["reference_video_upload_ids"] = [kf_upload(r, token) for r in a.ref_video]
    if a.ref_audio:
        body["reference_audio_upload_ids"] = [kf_upload(r, token) for r in a.ref_audio]
    res = http("POST", f"{KREATORFLOW}/videos", token, body, headers={"Idempotency-Key": str(uuid.uuid4())})
    d = res.get("data", res)
    job = d.get("job") or d
    job_id = job.get("id")
    if not job_id:
        sys.exit(f"no job id in response:\n{json.dumps(res, indent=1)[:1500]}")
    tokens = d.get("quoted_token_cost") or job.get("quotedTokenCost")
    return job_id, {"tokens": tokens, "usd": round(tokens * 0.05, 3) if tokens else None}, res


def kf_poll(job_id, token, dest):
    while True:
        res = http("GET", f"{KREATORFLOW}/jobs/{job_id}", token)
        job = res.get("data", res).get("job") or res.get("data", res)
        status = job.get("status")
        print(f"  {job_id}: {status}", file=sys.stderr)
        if status == "completed":
            try:
                download(f"{KREATORFLOW}/jobs/{job_id}/output", dest, token)
            except Exception:
                download(job["providerOutputUrl"], dest, token)
            tokens = job.get("finalTokenCost") or job.get("quotedTokenCost")
            return {"tokens": tokens, "usd": round(tokens * 0.05, 3) if tokens else None}, job
        if status in ("failed", "canceled", "blocked"):
            sys.exit(f"job {job_id} {status}: {job.get('errorCode') or job}")
        time.sleep(8)


# ---------------------------------------------------------------- Kie.ai (Kling 3.0, Topaz)

def kie_upload(path, token, folder="livestage"):
    path = Path(path)
    boundary = uuid.uuid4().hex
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    parts = []
    for name, val in (("uploadPath", folder), ("fileName", path.name)):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{val}\r\n".encode())
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{path.name}\"\r\n"
                 f"Content-Type: {mime}\r\n\r\n".encode() + path.read_bytes() + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    res = http("POST", f"{KIE_UPLOAD}/file-stream-upload", token, raw=b"".join(parts),
               headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=600)
    url = (res.get("data") or {}).get("downloadUrl")
    if not url:
        sys.exit(f"upload failed:\n{json.dumps(res, indent=1)[:1500]}")
    return url


def kie_create_task(model, inp, token):
    res = http("POST", f"{KIE}/jobs/createTask", token, {"model": model, "input": inp})
    if res.get("code") != 200:
        sys.exit(f"Kie.ai refused the task: {res.get('code')} {res.get('msg')}\n{json.dumps(inp, indent=1)[:1200]}")
    return res["data"]["taskId"], res


def kie_poll(task_id, token, dest):
    while True:
        res = http("GET", f"{KIE}/jobs/recordInfo?taskId={task_id}", token)
        d = res.get("data") or {}
        state = d.get("state")
        print(f"  {task_id}: {state}", file=sys.stderr)
        if state == "success":
            rj = d.get("response") or json.loads(d.get("resultJson") or "{}")
            urls = rj.get("resultUrls") or []
            if not urls:
                sys.exit(f"task {task_id} succeeded with no resultUrls:\n{json.dumps(d, indent=1)[:1500]}")
            download(urls[0], dest)
            return {"credits": d.get("creditsConsumed")}, d
        if state == "fail":
            sys.exit(f"task {task_id} failed: {d.get('failCode')} {d.get('failMsg')}")
        time.sleep(8)


def kling_create(a, mode, token):
    inp = {"prompt": a.prompt, "sound": bool(a.audio), "duration": str(a.duration), "mode": mode, "multi_shots": False}
    if a.first:
        inp["image_urls"] = [kie_upload(a.first, token)] + ([kie_upload(a.last, token)] if a.last else [])
    else:
        inp["aspect_ratio"] = a.ratio
    if a.last and not a.first:
        sys.exit("Kling needs a first frame to take a last frame")
    if a.ref or a.ref_video or a.ref_audio:
        sys.exit("Kling references go through kling_elements (named @element with 2-4 images): not wired yet, use --model fast")
    return kie_create_task("kling-3.0/video", inp, token)


# ---------------------------------------------------------------- shared

def estimate(alias, res, duration, audio):
    provider, _, prices, max_s = MODELS[alias]
    if duration > max_s:
        sys.exit(f"{alias} renders at most {max_s} s")
    if res not in prices:
        sys.exit(f"{alias} has no {res} (choose from {', '.join(prices)})")
    per = prices[res] + (KLING_SOUND_PER_SEC - 0.07 if provider == "kie" and audio else 0)
    return round(per * duration, 3)


def log(folder, entry):
    subprocess.run([sys.executable, str(GENLOG), "add", str(folder), json.dumps(entry)], check=True)


def rel(p):
    try:
        return str(Path(p).resolve().relative_to(ROOT))
    except ValueError:
        return str(p)


def cmd_video(a):
    env()
    if a.model not in MODELS:
        sys.exit(f"unknown model {a.model}; one of {', '.join(MODELS)}")
    provider, model_id, _, _ = MODELS[a.model]
    if provider == "kie":
        a.res = KLING_RES[model_id]
        if a.ratio not in ("16:9", "9:16", "1:1") and not a.first:
            sys.exit("Kling 3.0 only renders 16:9, 9:16 or 1:1 (no 21:9). Pass a first frame (the output follows it) or --ratio 16:9.")
    a.prompt = Path(a.prompt_file).read_text(encoding="utf-8").strip() if a.prompt_file else a.prompt
    if not a.prompt:
        sys.exit("give --prompt or --prompt-file")
    folder = Path(a.folder).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / a.out
    usd = estimate(a.model, a.res, a.duration, a.audio)
    settings = {"resolution": a.res, "ratio": a.ratio, "duration": a.duration, "audio": bool(a.audio)}
    if a.seed is not None:
        settings["seed"] = a.seed
    print(f"{a.model} ({provider} {model_id}) {a.res} {a.ratio} {a.duration}s -> {rel(dest)}   ~${usd:.2f}", file=sys.stderr)
    if a.dry_run:
        print(json.dumps({"provider": provider, "model": model_id, "settings": settings, "prompt": a.prompt,
                          "first": a.first, "last": a.last, "ref": a.ref, "estimate_usd": usd}, indent=1))
        return
    sources = {k: rel(v) for k, v in (("firstFrame", a.first), ("lastFrame", a.last)) if v}
    for i, r in enumerate(a.ref or []):
        sources[f"ref{i + 1}"] = rel(r)
    if provider == "kreatorflow":
        token = key("KREATORFLOW_API_KEY")
        job_id, cost, created = kf_create(a, model_id, token)
        tool = "gen.py kreatorflow"
    else:
        token = key("KIE_API_KEY")
        job_id, created = kling_create(a, model_id, token)
        cost = {"usd": usd}
        tool = "gen.py kie"
    entry = {"output": a.out, "status": a.status, "scenes": a.scenes or [], "assets": a.assets or [],
             "tool": tool, "model": f"{a.model} ({model_id})", "settings": settings, "sources": sources,
             "taskId": job_id, "credits": cost.get("usd") or usd, "prompt": a.prompt}
    if a.note:
        entry["note"] = a.note
    log(folder, entry)  # logged when the job starts, as the ground rules ask
    (folder / (dest.stem + ".json")).write_text(json.dumps({"request": entry, "created": created}, indent=1))
    final_cost, job = (kf_poll if provider == "kreatorflow" else kie_poll)(job_id, token, dest)
    (folder / (dest.stem + ".json")).write_text(json.dumps({"request": entry, "created": created, "job": job}, indent=1))
    secs = probe_seconds(dest)
    print(f"{rel(dest)}" + (f"  {secs:.1f}s" if secs else "") + f"  cost {final_cost}")


def cmd_upscale(a):
    env()
    token = key("KIE_API_KEY")
    folder = Path(a.folder).resolve()
    src = folder / a.inp if not Path(a.inp).is_absolute() else Path(a.inp)
    if not src.exists():
        sys.exit(f"{src} not found")
    if src.stat().st_size > 50 * 1024 * 1024:
        sys.exit("Topaz on Kie.ai takes files up to 50 MB: re-encode the clip smaller first")
    out = a.out or f"{src.stem}-{a.factor}x{src.suffix}"
    dest = folder / out
    print(f"topaz/video-upscale x{a.factor}: {rel(src)} -> {rel(dest)}", file=sys.stderr)
    if a.dry_run:
        return
    url = kie_upload(src, token)
    task_id, created = kie_create_task("topaz/video-upscale", {"video_url": url, "upscale_factor": str(a.factor)}, token)
    entry = {"output": out, "status": a.status, "scenes": a.scenes or [], "assets": a.assets or [],
             "tool": "gen.py kie upscale", "model": "topaz/video-upscale", "settings": {"factor": a.factor},
             "sources": {"video": rel(src)}, "taskId": task_id, "prompt": f"upscale {src.name} x{a.factor}"}
    log(folder, entry)
    cost, job = kie_poll(task_id, token, dest)
    (folder / (dest.stem + ".json")).write_text(json.dumps({"request": entry, "created": created, "job": job}, indent=1))
    print(f"{rel(dest)}  cost {cost}")


def cmd_status(a):
    env()
    if a.provider == "kreatorflow":
        print(json.dumps(http("GET", f"{KREATORFLOW}/jobs/{a.id}", key("KREATORFLOW_API_KEY")), indent=1))
    else:
        print(json.dumps(http("GET", f"{KIE}/jobs/recordInfo?taskId={a.id}", key("KIE_API_KEY")), indent=1))


def cmd_models(a):
    env()
    print(json.dumps(http("GET", f"{KREATORFLOW}/models", key("KREATORFLOW_API_KEY")), indent=1))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("video", help="generate a clip")
    v.add_argument("folder", help="media-src folder the output and its log line go in")
    v.add_argument("--out", required=True, help="output file name, e.g. 1.2-lion-idle.mp4")
    v.add_argument("--prompt")
    v.add_argument("--prompt-file")
    v.add_argument("--model", default="fast", help=", ".join(MODELS) + " (default fast)")
    v.add_argument("--res", default="720p", help="480p | 720p | 1080p | 4k (default 720p; Kling takes it from the model)")
    v.add_argument("--ratio", default="21:9", help="16:9 9:16 1:1 4:3 3:4 21:9 adaptive (default 21:9)")
    v.add_argument("--duration", type=int, default=10)
    v.add_argument("--audio", action="store_true", help="let the model write sound (off by default)")
    v.add_argument("--seed", type=int)
    v.add_argument("--first", help="first frame image")
    v.add_argument("--last", help="last frame image")
    v.add_argument("--ref", nargs="*", help="reference images (not with first/last on Seedance)")
    v.add_argument("--ref-video", nargs="*")
    v.add_argument("--ref-audio", nargs="*")
    v.add_argument("--scenes", nargs="*", help="LiveStage scene codes/ids this feeds")
    v.add_argument("--assets", nargs="*", help="LiveStage asset ids")
    v.add_argument("--status", default="draft", choices=("used", "draft", "rejected", "superseded"))
    v.add_argument("--note")
    v.add_argument("--dry-run", action="store_true")
    v.set_defaults(fn=cmd_video)

    u = sub.add_parser("upscale", help="Topaz upscale on Kie.ai")
    u.add_argument("folder")
    u.add_argument("--in", dest="inp", required=True, help="clip to upscale (in the folder, or a path)")
    u.add_argument("--out")
    u.add_argument("--factor", type=int, default=2, choices=(1, 2, 4))
    u.add_argument("--scenes", nargs="*")
    u.add_argument("--assets", nargs="*")
    u.add_argument("--status", default="draft", choices=("used", "draft", "rejected", "superseded"))
    u.add_argument("--dry-run", action="store_true")
    u.set_defaults(fn=cmd_upscale)

    s = sub.add_parser("status", help="show a job")
    s.add_argument("provider", choices=("kreatorflow", "kie"))
    s.add_argument("id")
    s.set_defaults(fn=cmd_status)

    m = sub.add_parser("models", help="KreatorFlow model list")
    m.set_defaults(fn=cmd_models)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
