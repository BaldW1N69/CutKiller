#!/usr/bin/env python3
"""CutKiller <-> DaVinci Resolve bridge.

Usage (two ways):
  1. Inside Resolve (works with the free version):
     copy this file into the Resolve Scripts folder (see resolve/README.md),
     then run Workspace > Scripts > cutkiller_bridge.
  2. From a terminal, Resolve open (needs Resolve Studio + Preferences >
     System > General > "External scripting using" = Local):
         python3 cutkiller_bridge.py            # connection test + state
         python3 cutkiller_bridge.py --json out.json

Writes a JSON snapshot of the open project (timelines, tracks, clips,
markers) so CutKiller can read it.
"""
import json
import os
import sys
from pathlib import Path

DEFAULT_PATHS = {
    "win32": (
        r"%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting",
        r"C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll",
    ),
    "darwin": (
        "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting",
        "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so",
    ),
    "linux": (
        "/opt/resolve/Developer/Scripting",
        "/opt/resolve/libs/Fusion/fusionscript.so",
    ),
}


def get_resolve():
    """Return the Resolve object, or exit with a clear diagnostic."""
    # Case 1: launched from Resolve's Scripts menu or console.
    existing = globals().get("resolve")
    if existing is not None:
        return existing
    bmd = globals().get("bmd")
    if bmd is not None:
        return bmd.scriptapp("Resolve")
    app = globals().get("app")
    if app is not None and hasattr(app, "GetResolve"):
        return app.GetResolve()

    # Case 2: external Python process.
    key = "win32" if sys.platform.startswith("win") else ("darwin" if sys.platform == "darwin" else "linux")
    api_dir, lib = DEFAULT_PATHS[key]
    api_dir = os.path.expandvars(os.environ.get("RESOLVE_SCRIPT_API", api_dir))
    os.environ.setdefault("RESOLVE_SCRIPT_API", api_dir)
    os.environ.setdefault("RESOLVE_SCRIPT_LIB", lib)
    sys.path.append(str(Path(api_dir) / "Modules"))
    try:
        import DaVinciResolveScript as dvr  # type: ignore
    except ImportError as exc:
        sys.exit(f"[KO] Module DaVinciResolveScript introuvable ({exc}).\n"
                 f"     Cherche dans : {Path(api_dir) / 'Modules'} — Resolve est-il installé ?")
    resolve = dvr.scriptapp("Resolve")
    if resolve is None:
        sys.exit("[KO] Resolve ne répond pas. Vérifie :\n"
                 "     - Resolve est ouvert, avec un projet ;\n"
                 "     - Préférences > Système > Général > « External scripting using » = Local ;\n"
                 "     - le pilotage externe exige Resolve Studio : avec la version gratuite,\n"
                 "       lance ce script depuis Workspace > Scripts.")
    return resolve


def snapshot(resolve):
    pm = resolve.GetProjectManager()
    project = pm.GetCurrentProject()
    state = {
        "resolve_version": resolve.GetVersionString(),
        "page": resolve.GetCurrentPage(),
        "project": project.GetName() if project else None,
        "timelines": [],
    }
    if not project:
        return state
    current = project.GetCurrentTimeline()
    state["current_timeline"] = current.GetName() if current else None
    state["settings"] = {
        k: project.GetSetting(k)
        for k in ("timelineResolutionWidth", "timelineResolutionHeight", "timelineFrameRate")
    }
    for i in range(1, project.GetTimelineCount() + 1):
        tl = project.GetTimelineByIndex(i)
        entry = {"name": tl.GetName(), "start_frame": tl.GetStartFrame(),
                 "end_frame": tl.GetEndFrame(), "markers": tl.GetMarkers(), "tracks": {}}
        for kind in ("video", "audio", "subtitle"):
            tracks = []
            for t in range(1, tl.GetTrackCount(kind) + 1):
                items = tl.GetItemListInTrack(kind, t) or []
                tracks.append({
                    "index": t,
                    "name": tl.GetTrackName(kind, t),
                    "clips": [{
                        "name": it.GetName(),
                        "start": it.GetStart(),
                        "end": it.GetEnd(),
                        "source_in": it.GetLeftOffset(),
                        "color": it.GetClipColor(),
                    } for it in items],
                })
            entry["tracks"][kind] = tracks
        state["timelines"].append(entry)
    return state


def main():
    resolve = get_resolve()
    state = snapshot(resolve)
    print(f"[OK] Connecté à DaVinci Resolve {state['resolve_version']}")
    print(f"     Projet : {state['project']} | timeline : {state.get('current_timeline')} | "
          f"{len(state['timelines'])} timeline(s)")
    out = None
    if "--json" in sys.argv:
        out = Path(sys.argv[sys.argv.index("--json") + 1])
    elif any(globals().get(n) is not None for n in ("resolve", "bmd", "app")):
        out = Path.home() / "cutkiller_resolve_state.json"
    if out:
        out.write_text(json.dumps(state, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        print(f"     État écrit dans : {out}")


main()
