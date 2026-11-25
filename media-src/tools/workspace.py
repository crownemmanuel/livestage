"""Where a show's files live on this computer, for the media tools.

LiveStage keeps every show in the workspace folder (Settings -> Workspace folder in the app, default
~/Documents/LiveStage):

    <workspace>/<show>/                 marked by .show.json (written by the app)
        <scene folder>/images|audio|video|other/   finals: what the wall plays (assets point here with `rel`)
        edits/                          editable work: Premiere edits, sources, drafts, prompts.jsonl logs, archive/

The repository holds the app only, never a show. Override with SLS_EDITS=<edits folder> or pick a show
by folder name with SLS_SHOW=<name> when the workspace holds more than one.
"""
import json
import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def workspace_root() -> Path:
    """The app's workspace setting on this computer (workspace.json in its data folder), else the default."""
    if sys.platform == "darwin":
        data = Path.home() / "Library" / "Application Support" / "org.salvation.livestudio"
    elif os.name == "nt":
        data = Path(os.environ.get("APPDATA", Path.home())) / "org.salvation.livestudio"
    else:
        data = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "org.salvation.livestudio"
    try:
        root = json.loads((data / "workspace.json").read_text()).get("root")
        if root:
            return Path(root)
    except (OSError, ValueError):
        pass
    return Path.home() / "Documents" / "LiveStage"


def show_dir() -> Path:
    """The show folder: the one in the workspace with a .show.json (SLS_SHOW picks one by name)."""
    if os.environ.get("SLS_EDITS"):
        return Path(os.environ["SLS_EDITS"]).expanduser().resolve().parent
    root = workspace_root()
    shows = sorted(p.parent for p in root.glob("*/.show.json"))
    want = os.environ.get("SLS_SHOW")
    if want:
        shows = [s for s in shows if s.name == want]
    if len(shows) != 1:
        names = ", ".join(s.name for s in shows) or "none"
        sys.exit(f"cannot tell which show in {root} to use (found: {names}); set SLS_SHOW=<folder name> or SLS_EDITS=<edits folder>")
    return shows[0]


def edits_dir() -> Path:
    """<show>/edits: where all editable work for the show goes."""
    if os.environ.get("SLS_EDITS"):
        return Path(os.environ["SLS_EDITS"]).expanduser().resolve()
    return show_dir() / "edits"


def short(p) -> str:
    """A path as people read it: relative to the show folder (edits/..., Prologue/video/...) or the repo."""
    p = Path(p).resolve()
    for base in (show_dir(), REPO):
        try:
            return str(p.relative_to(base.resolve()))
        except ValueError:
            pass
    return str(p)


if __name__ == "__main__":
    # EDITS="$(python3 media-src/tools/workspace.py)" puts the edits folder in a shell variable.
    print(edits_dir())
