#!/usr/bin/env python3
"""The generation log: every prompt we ran, with its model, settings and source files, findable by
the LiveStage scene or asset it feeds. Each folder under media-src/ keeps its own prompts.jsonl
(one JSON object per line); this tool adds to them and searches all of them.

    # log a generation (write it when the job starts; the folder is where its output lands)
    python3 media-src/tools/genlog.py add media-src/scene1/bg01-hd '{
        "output": "left-palm-kling.mp4", "status": "used",
        "scenes": ["2.1"], "assets": ["asset_1oydh0a14v1"],
        "tool": "runway generate_video", "model": "kling-4",
        "settings": {"resolution": "1080p", "ratio": "16:9", "duration": 10},
        "sources": {"startFrame": "media-src/scene1/bg01-hd/left-palm-1080.jpg"},
        "taskId": "01bc95db-...", "credits": 177, "prompt": "Camera completely locked off ..."}'

    # find what made a scene / asset / file, to regenerate it the same way
    python3 media-src/tools/genlog.py find 1.7            # scene code
    python3 media-src/tools/genlog.py find scene_1ee655e1qgy
    python3 media-src/tools/genlog.py find asset_v3xhi31alh2
    python3 media-src/tools/genlog.py find palm            # any text: output, prompt, notes
    python3 media-src/tools/genlog.py find 1.7 --full      # whole prompts, not just their start

Fields: date (added for you), output (file name in the folder), status (used | draft | rejected |
superseded), scenes (LiveStage scene codes and/or ids; codes shift, ids do not), assets (LiveStage
asset ids of the files built from it), tool, model, settings, sources (role -> repo-relative file,
or a Runway task id when the source only exists there), taskId, credits, prompt, note.
"""
import argparse
import datetime
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MEDIA = ROOT / "media-src"
REQUIRED = ("output", "status", "scenes", "tool", "model", "prompt")
STATUSES = ("used", "draft", "rejected", "superseded")


def entries():
    for log in sorted(MEDIA.rglob("prompts.jsonl")):
        for n, line in enumerate(log.read_text(encoding="utf-8").splitlines(), 1):
            if line.strip():
                yield log.parent, n, json.loads(line)


def add(folder, raw):
    e = json.loads(raw)
    missing = [k for k in REQUIRED if k not in e]
    if missing:
        sys.exit(f"missing fields: {', '.join(missing)}")
    if e["status"] not in STATUSES:
        sys.exit(f"status must be one of {STATUSES}")
    e.setdefault("date", datetime.date.today().isoformat())
    folder = Path(folder).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    with (folder / "prompts.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(e, ensure_ascii=False) + "\n")
    print(f"logged {e['output']} in {(folder / 'prompts.jsonl').relative_to(ROOT)}")


def matches(e, q):
    q = q.lower()
    if any(q == str(s).lower() for s in e.get("scenes", []) + e.get("assets", [])):
        return True
    return q in json.dumps(e, ensure_ascii=False).lower()


def find(q, full):
    hits = [(d, n, e) for d, n, e in entries() if matches(e, q)]
    for d, n, e in hits:
        rel = d.relative_to(ROOT)
        print(f"── {rel}/{e['output']}  [{e.get('status')}]  {e.get('date', '')}")
        print(f"   scenes {', '.join(map(str, e.get('scenes', [])))}   assets {', '.join(e.get('assets', [])) or '-'}")
        print(f"   {e.get('tool')} · {e.get('model')} · {json.dumps(e.get('settings', {}))}")
        for role, src in (e.get("sources") or {}).items():
            print(f"   source {role}: {src}")
        if e.get("taskId"):
            print(f"   task {e['taskId']}" + (f" · {e['credits']} credits" if e.get("credits") else ""))
        p = e.get("prompt") or ""
        print("   prompt: " + (p if full else (p[:220] + ("…" if len(p) > 220 else ""))))
        if e.get("note"):
            print(f"   note: {e['note']}")
    if not hits:
        print(f"nothing logged for {q!r}")
    else:
        print(f"{len(hits)} generation(s); log lines in each folder's prompts.jsonl")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("folder")
    a.add_argument("json")
    f = sub.add_parser("find")
    f.add_argument("query")
    f.add_argument("--full", action="store_true")
    args = ap.parse_args()
    if args.cmd == "add":
        add(args.folder, args.json)
    else:
        find(args.query, args.full)


if __name__ == "__main__":
    main()
