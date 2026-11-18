"""Interface en ligne de commande : `cutkiller <commande>`."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from cutkiller import __version__


def _out_path(src: Path, suffix: str, given: str | None) -> Path:
    return Path(given) if given else src.with_name(f"{src.stem}{suffix}{src.suffix or '.mp4'}")


def _add_silence_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--threshold", type=float, default=None, help="seuil de silence en dBFS (défaut : auto)")
    p.add_argument("--min-silence", type=float, default=0.35, help="durée min d'un silence à couper (s)")


def _add_cut_args(p: argparse.ArgumentParser) -> None:
    _add_silence_args(p)
    p.add_argument("--padding", type=float, default=0.08, help="respiration gardée autour de la parole (s)")
    p.add_argument("--remove-fillers", action="store_true", help="coupe aussi les 'euh/um' (nécessite la transcription)")
    p.add_argument("--whisper-model", default="small", help="modèle faster-whisper (tiny, base, small, medium, large-v3)")
    p.add_argument("--language", default=None, help="langue forcée pour la transcription (fr, en…)")
    g = p.add_argument_group("punch-in (jump cut fix)")
    g.add_argument("--punch-in", type=float, default=0.0, metavar="ÉCHELLE",
                   help="alterne plan normal / plan resserré à chaque coupe (ex. 1.15) : les jump cuts deviennent "
                        "des changements de cadrage volontaires. 0 = désactivé")
    g.add_argument("--punch-pattern", metavar="Z1,Z2,…", help="motif d'échelles explicite, ex. 1,1.15,1,1.3 (max 1.5)")
    g.add_argument("--punch-ramp", type=int, default=3, help="images de micro-zoom à cheval sur la coupe (0 = coupe sèche)")
    g.add_argument("--punch-focus", default="0.5,0.4", metavar="X,Y", help="point gardé en zoomant (0.5,0.4 = visage)")


def _punch(a: argparse.Namespace, n_clips: int, joins) -> dict:
    """Arguments de render_cuts pour le punch-in (vide si désactivé)."""
    from cutkiller.edit.timeline import punch_zooms

    if a.punch_pattern:
        pattern = [float(x) for x in a.punch_pattern.split(",") if x.strip()]
    elif a.punch_in:
        pattern = [1.0, a.punch_in]
    else:
        return {}
    if any(z < 1.0 or z > 1.5 for z in pattern):
        raise ValueError("Échelles de punch-in entre 1.0 et 1.5 (au-delà, l'image perd trop de définition)")
    steps = [abs(b - a_) for a_, b in zip(pattern, pattern[1:] + pattern[:1]) if b != a_]
    if steps and min(steps) < 0.1:
        print("  ! écart de punch-in < 10 % : ça risque de ressembler à un saut d'image plutôt qu'à un recadrage",
              file=sys.stderr)
    fx, fy = (float(v) for v in a.punch_focus.split(","))
    zooms = punch_zooms(n_clips, joins, pattern)
    print(f"  Punch-in : {sum(z != 1.0 for z in zooms)}/{n_clips} plans resserrés")
    return {"zooms": zooms, "focus": (fx, fy), "zoom_ramp": a.punch_ramp}


# ---------------------------------------------------------------- listen
def cmd_listen(a: argparse.Namespace) -> int:
    from cutkiller.listen import listen
    from cutkiller.listen.transcribe import to_srt

    rep = listen(a.input, threshold_db=a.threshold, min_silence=a.min_silence, with_beats=a.beats,
                 with_transcript=a.transcribe, whisper_model=a.whisper_model, language=a.language,
                 target_lufs=a.target_lufs)
    print(rep.summary())
    src = Path(a.input)
    out = Path(a.output) if a.output else src.with_suffix(".listen.json")
    out.write_text(json.dumps(rep.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nRapport JSON : {out}")
    if rep.words:
        srt = src.with_suffix(".srt")
        srt.write_text(to_srt(rep.words), encoding="utf-8")
        print(f"Sous-titres  : {srt}")
    return 0


# ---------------------------------------------------------------- cut
def _plan_cut(a: argparse.Namespace):
    from cutkiller.edit.cutlist import CutSettings, build_keep_segments, snap_segments
    from cutkiller.listen import Interval, listen

    rep = listen(a.input, threshold_db=a.threshold, min_silence=a.min_silence, with_loudness=False,
                 with_transcript=a.remove_fillers, whisper_model=a.whisper_model, language=a.language)
    remove = list(rep.silences) + [Interval(s, e) for s, e in rep.fillers]
    segs = build_keep_segments(rep.media.duration, remove, CutSettings(padding=a.padding))
    if getattr(a, "snap_to", None):
        from cutkiller.listen.beats import analyze_beats
        from cutkiller.media import ANALYSIS_SR, load_audio

        grid = analyze_beats(load_audio(a.input, ANALYSIS_SR), ANALYSIS_SR).onsets
        segs = snap_segments(segs, grid, tolerance=0.06)
    return rep, segs


def cmd_cut(a: argparse.Namespace) -> int:
    from cutkiller.edit.cutlist import total_duration
    from cutkiller.edit.render import render_cuts

    rep, segs = _plan_cut(a)
    kept = total_duration(segs)
    print(f"{len(segs)} segments gardés : {rep.media.duration:.1f} s → {kept:.1f} s (-{rep.media.duration - kept:.1f} s)")
    if a.dry_run:
        print(json.dumps([s.to_dict() for s in segs], indent=1))
        return 0
    from cutkiller.edit.cutlist import output_cut_points

    joins = _joins(a, output_cut_points(segs))
    out = render_cuts(a.input, _out_path(Path(a.input), "_cut", a.output), segs, joins=joins, log=print,
                      **_punch(a, len(segs), joins))
    print(f"Export : {out}")
    return 0


# ---------------------------------------------------------------- text
def cmd_text(a: argparse.Namespace) -> int:
    from cutkiller.edit.text import Cue, burn_text, parse_cue, parse_srt

    if a.ass:
        from cutkiller.edit.text import burn_ass

        out = burn_ass(a.input, _out_path(Path(a.input), "_text", a.output), Path(a.ass).read_text(encoding="utf-8-sig"))
        print(f"Script ASS gravé\nExport : {out}")
        return 0
    cues = [parse_cue(t) for t in a.text or []]
    if a.srt:
        for c in parse_srt(Path(a.srt).read_text(encoding="utf-8-sig")):
            c.position = a.srt_position
            cues.append(c)
    if not cues:
        raise ValueError("Rien à incruster : utilise --text « texte@0-3 », --srt fichier.srt ou --ass script.ass")
    out = burn_text(a.input, _out_path(Path(a.input), "_text", a.output), cues, size=a.size, color=a.color,
                    font=a.font, box=a.box, outline=a.outline, fade=a.fade)
    print(f"{len(cues)} texte(s) incrusté(s)\nExport : {out}")
    return 0


# ---------------------------------------------------------------- animate / overlay / captions
def _kv(pairs: list[str]) -> dict:
    from cutkiller.transitions import _value

    out = {}
    for item in pairs or []:
        if "=" not in item:
            raise ValueError(f"Paramètre invalide « {item} » : format clé=valeur (ex. text=\"SOLDES\" color=yellow)")
        k, v = item.split("=", 1)
        out[k.strip()] = _value(v) if k.strip() not in ("text", "subtitle", "label", "prefix", "suffix", "path") else v
    return out


def cmd_animate(a: argparse.Namespace) -> int:
    from cutkiller.animate import Ctx, load_script, render, stills
    from cutkiller.animate.presets import PRESETS, preset_frame
    from cutkiller.media import probe

    if a.list or not a.name:
        for name, (_, desc, params) in PRESETS.items():
            print(f"{name:<18} {desc:<48} [{params}]")
        print("\n+ script sur mesure : cutkiller animate mon_anim.py (fonction frame(t, ctx))")
        print("+ page HTML/CSS/JS : cutkiller animate anim.html (temps piloté image par image, fond transparent)")
        return 0
    meta: dict = {}
    is_html = a.name.lower().endswith((".html", ".htm"))
    if a.name.endswith(".py"):
        fn, meta = load_script(a.name)
        stem = Path(a.name).stem
    elif is_html:
        fn, stem = None, Path(a.name).stem
    else:
        fn, stem = preset_frame(a.name), a.name
    w, h, fps = 1080, 1920, 30.0
    if a.like:
        info = probe(a.like)
        w, h, fps = info.width or w, info.height or h, info.fps or fps
    if meta.get("size"):
        w, h = meta["size"]
    if a.size:
        w, h = (int(v) for v in a.size.lower().split("x"))
    fps = a.fps or meta.get("fps") or fps
    w, h = w - w % 2, h - h % 2
    scene = None
    if is_html:
        from cutkiller.animate.html import HtmlScene

        scene = fn = HtmlScene(a.name, w, h, float(fps), a.duration, params=_kv(a.params))
        meta["duration"] = scene.duration
    try:
        duration = a.duration or meta.get("duration") or 3.0
        ctx = Ctx(w, h, float(fps), float(duration), font_path=a.font, params=_kv(a.params))
        out = Path(a.output or f"{stem}.mov")
        if a.preview is not None:
            times = [float(x) for x in a.preview.split(",")] if a.preview else [duration * f for f in (0.1, 0.35, 0.6, 0.9)]
            for p in stills(fn, ctx, sorted(times), out.with_name(out.stem + "_preview"), stem):
                print(f"Aperçu : {p}")
            return 0
        render(fn, out, ctx, log=print)
    finally:
        if scene is not None:
            scene.close()
    print(f"{ctx.w}x{ctx.h}, {duration:g} s à {fps:g} i/s (fond transparent)")
    print(f"Export : {out}")
    return 0


TEXTURE_FIELDS = ("grade", "contrast", "sharpen", "glow", "letterbox", "grain", "grain_mode", "grain_opacity",
                  "dither", "colors", "pixel", "vignette")


def cmd_texture(a: argparse.Namespace) -> int:
    from cutkiller.edit.texture import LOOKS, TextureSettings, render_texture

    values = dict(LOOKS[a.look]) if a.look else {}
    values.update({k: getattr(a, k) for k in TEXTURE_FIELDS if getattr(a, k) is not None})  # les options priment
    settings = TextureSettings(grain_file=Path(a.grain_file) if a.grain_file else None, **values)
    if settings.letterbox:
        from cutkiller.media import probe

        info = probe(a.input)
        if info.height and info.width and info.height > info.width:
            print("  ! bandes cinéma sur une vidéo verticale : il ne reste qu'une bande d'image au centre",
                  file=sys.stderr)
    out = render_texture(a.input, _out_path(Path(a.input), "_texture", a.output), settings)
    done = [f"look {a.look}"] if a.look else []
    done += [k.replace("_", " ") for k in TEXTURE_FIELDS
             if getattr(settings, k) and k not in ("grain_mode", "grain_opacity", "colors", "pixel")]
    if a.grain_file:
        done.append("grain scanné")
    print(f"Finition : {', '.join(done)}\nExport : {out}")
    return 0


def cmd_overlay(a: argparse.Namespace) -> int:
    from cutkiller.edit.overlay import parse_layer, render_overlays

    layers = [parse_layer(x) for x in a.add or []]
    out = render_overlays(a.input, _out_path(Path(a.input), "_overlay", a.output), layers)
    print(f"{len(layers)} calque(s) incrusté(s)\nExport : {out}")
    return 0


def cmd_captions(a: argparse.Namespace) -> int:
    from cutkiller.edit.captions import build_captions_ass, load_words
    from cutkiller.edit.text import burn_ass, font_family
    from cutkiller.media import probe

    src = Path(a.input)
    if a.transcribe:
        from cutkiller.listen.transcribe import transcribe

        words, _ = transcribe(src, a.whisper_model, a.language)
    else:
        report = Path(a.words) if a.words else src.with_suffix(".listen.json")
        if not report.exists():
            raise ValueError(f"Pas de mots horodatés : lance « cutkiller listen {src.name} --transcribe » "
                             f"(ou passe --transcribe / --words rapport.listen.json).")
        words = load_words(report)
    info = probe(src)
    family, font_file = font_family(a.font)
    ass = build_captions_ass(words, info.width or 1080, info.height or 1920, style=a.style, color=a.color,
                             active=a.active, size=a.size, position=a.position, font=family, max_words=a.max_words)
    out = burn_ass(src, _out_path(src, "_captions", a.output), ass, font_file=font_file)
    print(f"{len(words)} mots, style {a.style}\nExport : {out}")
    return 0


# ---------------------------------------------------------------- doctor
def run_doctor() -> list[dict]:
    """Vérifie l'installation. Chaque ligne : {name, status: ok|warn|fail, detail, fix}."""
    import importlib.util
    import os
    import platform
    import shutil
    import subprocess

    rows: list[dict] = []

    def add(name, status, detail="", fix=""):
        rows.append({"name": name, "status": status, "detail": detail, "fix": fix})

    add("python", "ok" if sys.version_info >= (3, 10) else "fail", platform.python_version(), "Python >= 3.10 requis")
    add("cutkiller", "ok", __version__)
    ff = shutil.which("ffmpeg")
    if not ff:
        add("ffmpeg", "fail", "introuvable",
            "Windows : winget install Gyan.FFmpeg (puis rouvrir le terminal) — macOS : brew install ffmpeg — Linux : apt install ffmpeg")
    else:
        out = subprocess.run([ff, "-hide_banner", "-filters"], capture_output=True, text=True, errors="replace").stdout
        ver = subprocess.run([ff, "-version"], capture_output=True, text=True, errors="replace").stdout.splitlines()[:1]
        missing = [f for f in ("xfade", "sidechaincompress", "loudnorm", "ass") if f" {f} " not in out]
        add("ffmpeg", "ok" if not missing else "fail", (ver[0] if ver else ff)[:70],
            f"filtres manquants : {', '.join(missing)} — installer un build ffmpeg complet" if missing else "")
    add("ffprobe", "ok" if shutil.which("ffprobe") else "fail", shutil.which("ffprobe") or "introuvable",
        "ffprobe est fourni avec ffmpeg")
    if importlib.util.find_spec("moderngl") is None:
        add("opengl (transitions gl:)", "warn", "moderngl absent",
            "pip install 'cutkiller[gl]' — sans lui, 71 transitions restent disponibles (xfade + fx)")
    else:
        try:
            from cutkiller.transitions.gl import GLRenderer

            r = GLRenderer(16, 16)
            info = r.ctx.info.get("GL_RENDERER", "?")
            r.release()
            add("opengl (transitions gl:)", "ok", info + (" (rendu logiciel : lent)" if "llvmpipe" in info.lower() else ""))
        except Exception as exc:  # noqa: BLE001
            add("opengl (transitions gl:)", "warn", str(exc)[:120], "installer/mettre à jour le pilote graphique")
    add("transcription (faster-whisper)", "ok" if importlib.util.find_spec("faster_whisper") else "warn",
        "installé" if importlib.util.find_spec("faster_whisper") else "absent",
        "" if importlib.util.find_spec("faster_whisper") else "pip install 'cutkiller[transcribe]' (sous-titres, coupe des « euh »)")
    if importlib.util.find_spec("playwright") is None:
        add("animations HTML (Playwright)", "warn", "absent",
            "pip install 'cutkiller[html]' puis playwright install chromium (animations HTML/CSS/JS, prompts motion design)")
    else:
        exe = os.environ.get("CUTKILLER_CHROMIUM")
        add("animations HTML (Playwright)", "ok", f"Chromium : {exe}" if exe else "installé",
            "" if exe else "si le rendu échoue : playwright install chromium (ou CUTKILLER_CHROMIUM=/chemin/vers/chrome)")
    add("serveur MCP", "ok" if importlib.util.find_spec("mcp") else "warn",
        "installé" if importlib.util.find_spec("mcp") else "absent",
        "" if importlib.util.find_spec("mcp") else "pip install 'cutkiller[mcp]'")
    from cutkiller.sounds.providers import all_providers

    for name, p in all_providers().items():
        hint = {"local": "CUTKILLER_SOUNDS_DIR", "freesound": "FREESOUND_API_KEY", "jamendo": "JAMENDO_CLIENT_ID"}.get(name, "")
        add(f"sons : {name}", "ok" if p.available() else "warn", "prêt" if p.available() else "non configuré",
            "" if p.available() or not hint else f"définir {hint}")
    try:
        from cutkiller.sounds import cache_dir

        probe_file = cache_dir() / ".write_test"
        probe_file.write_text("ok", encoding="utf-8")
        probe_file.unlink()
        add("cache", "ok", str(cache_dir()))
    except OSError as exc:
        add("cache", "fail", str(exc), "définir CUTKILLER_CACHE vers un dossier accessible en écriture")
    return rows


def cmd_doctor(a: argparse.Namespace) -> int:
    rows = run_doctor()
    if a.json:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
    else:
        mark = {"ok": "OK  ", "warn": "--  ", "fail": "KO  "}
        for r in rows:
            print(f"{mark[r['status']]}{r['name']:<34} {r['detail']}")
            if r["fix"] and r["status"] != "ok":
                print(f"      → {r['fix']}")
    return 1 if any(r["status"] == "fail" for r in rows) else 0


# ---------------------------------------------------------------- transitions
def _add_transition_args(p: argparse.ArgumentParser) -> None:
    g = p.add_argument_group("transitions")
    g.add_argument("--transition", metavar="SPEC",
                   help="ex. fade, gl:Cube, fx:zoom_punch, random, random:glitch, 'fade|gl:WhipPan' "
                        "(liste : cutkiller transitions list)")
    g.add_argument("--transition-duration", type=float, default=0.4, help="durée en secondes (défaut 0.4)")
    g.add_argument("--transition-every", type=int, default=1, help="une transition toutes les N coupes")
    g.add_argument("--transition-min-gap", type=float, default=0.0, help="écart minimum entre deux transitions (s)")
    g.add_argument("--seed", type=int, default=None, help="graine pour les tirages aléatoires (reproductible)")
    g.add_argument("--audio-fade", type=float, default=0.03, help="fondu croisé audio aux coupes (s)")
    g.add_argument("--jl", type=float, default=0.0, help="décalage son/image : >0 L-cut, <0 J-cut (s)")


def _joins(a: argparse.Namespace, cut_times: list[float], strong: list[bool] | None = None):
    from cutkiller.edit.timeline import assign_joins
    from cutkiller.transitions import Picker

    picker = Picker(a.transition, seed=a.seed) if getattr(a, "transition", None) else None
    joins = assign_joins(cut_times, picker, duration=a.transition_duration, every=a.transition_every,
                         min_gap=a.transition_min_gap, audio_fade=a.audio_fade, jl=a.jl, strong=strong)
    a._transition_times = [t for t, j in zip(cut_times, joins) if j.transition is not None]
    a._transition_events = [(t, j.transition) for t, j in zip(cut_times, joins) if j.transition is not None]
    return joins


def cmd_transitions_list(a: argparse.Namespace) -> int:
    from cutkiller.transitions import catalog
    from cutkiller.transitions import gl as glmod

    items = catalog()
    if a.family:
        items = [t for t in items if t.family == a.family]
    if a.tag:
        items = [t for t in items if a.tag.lower() in t.tags]
    if a.search:
        q = a.search.lower()
        items = [t for t in items if q in t.name.lower() or q in t.description.lower()]
    if a.json:
        print(json.dumps([{"id": t.id, "description": t.description, "tags": t.tags} for t in items], ensure_ascii=False, indent=1))
        return 0
    for t in items:
        print(f"{t.id:<34} {t.description[:70]:<70} [{', '.join(t.tags[:4])}]")
    counts = {f: sum(1 for t in items if t.family == f) for f in ("xfade", "fx", "gl")}
    print(f"\n{len(items)} transitions (xfade {counts['xfade']}, fx {counts['fx']}, gl {counts['gl']})"
          + ("" if glmod.available() else " — GL : pip install 'cutkiller[gl]'"))
    print("+ illimité : pack:<vidéo>, luma:<image>, glsl:<shader>, xfade:custom?expr=…")
    return 0


def cmd_transitions_tags(_: argparse.Namespace) -> int:
    from cutkiller.transitions import all_tags

    for tag, n in all_tags().items():
        print(f"{tag:<16} {n}")
    return 0


def cmd_transitions_info(a: argparse.Namespace) -> int:
    from cutkiller.transitions import gl as glmod
    from cutkiller.transitions import resolve

    t = resolve(a.name)
    print(f"{t.id}\n  {t.description}\n  thèmes : {', '.join(t.tags)}")
    if t.family == "gl":
        spec = glmod.catalog()[t.name]
        print(f"  auteur : {spec.get('author')} — licence {spec.get('license')}")
        for k, v in (spec.get("defaultParams") or {}).items():
            print(f"  ?{k}={v}  ({spec['paramsTypes'].get(k)})")
    return 0


def cmd_transitions_preview(a: argparse.Namespace) -> int:
    from cutkiller.transitions import resolve
    from cutkiller.transitions.frames import VideoFormat
    from cutkiller.transitions.preview import render_preview

    t = resolve(a.name)
    out = Path(a.output or f"preview_{t.family}_{t.name}.mp4")
    fmt = VideoFormat.parse_size(a.size, a.fps)
    render_preview(t, out, a=Path(a.a) if a.a else None, b=Path(a.b) if a.b else None, duration=a.duration, fmt=fmt)
    print(f"Aperçu : {out}")
    return 0


def cmd_transitions_gallery(a: argparse.Namespace) -> int:
    from cutkiller.transitions import catalog
    from cutkiller.transitions.frames import VideoFormat
    from cutkiller.transitions.preview import gallery

    items = catalog()
    if a.family:
        items = [t for t in items if t.family == a.family]
    if a.tag:
        items = [t for t in items if a.tag.lower() in t.tags]
    page = gallery(Path(a.folder), items, fmt=VideoFormat.parse_size(a.size, a.fps), duration=a.duration)
    print(f"Galerie : {page}")
    return 0


# ---------------------------------------------------------------- sounds
def _print_sounds(sounds, errors) -> None:
    for i, s in enumerate(sounds, 1):
        dur = f"{s.duration:6.1f}s" if s.duration else "     ?s"
        flag = "" if s.commercial_ok else "  [licence restreinte]"
        print(f"{i:2d}. {s.ref:<52} {dur}  {s.license:<9} {s.title[:50]}{flag}")
    for name, err in errors.items():
        print(f"   ! {name}: {err}", file=sys.stderr)
    if not sounds:
        print("Aucun résultat.")


def cmd_sounds_search(a: argparse.Namespace) -> int:
    from cutkiller import sounds

    res, errors = sounds.search(a.query, kind=a.kind, providers=a.provider, limit=a.limit,
                                max_duration=a.max_duration, min_duration=a.min_duration,
                                commercial=not a.allow_nc)
    if a.json:
        print(json.dumps([s.to_dict() for s in res], ensure_ascii=False, indent=2))
    else:
        _print_sounds(res, errors)
    return 0


def cmd_sounds_get(a: argparse.Namespace) -> int:
    from cutkiller import sounds

    res, errors = sounds.search(a.query, kind=a.kind, providers=a.provider, limit=max(a.pick, 1),
                                max_duration=a.max_duration, min_duration=a.min_duration,
                                commercial=not a.allow_nc)
    if len(res) < a.pick:
        _print_sounds(res, errors)
        return 1
    s = res[a.pick - 1]
    path = sounds.download(s, Path(a.dest) if a.dest else None)
    print(f"{path}\n{s.attribution()}")
    if s.needs_attribution:
        print("→ Crédit obligatoire en description (licence CC-BY).")
    return 0


def cmd_sounds_providers(_: argparse.Namespace) -> int:
    from cutkiller.sounds.providers import all_providers

    hints = {"local": "CUTKILLER_SOUNDS_DIR=/chemin/vers/mes/sons", "openverse": "aucune clé requise",
             "freesound": "FREESOUND_API_KEY (https://freesound.org/apiv2/apply)",
             "jamendo": "JAMENDO_CLIENT_ID (https://devportal.jamendo.com)"}
    for name, p in all_providers().items():
        print(f"{'OK ' if p.available() else '-- '} {name:<10} {hints[name]}")
    return 0


# ---------------------------------------------------------------- mix
def _resolve_sound(spec: str, kind: str, credits, *, max_duration=None, min_duration=None, target=None):
    """Un chemin local existant, ou une requête texte résolue sur les banques."""
    from cutkiller import sounds

    p = Path(spec).expanduser()
    if p.exists():
        return p
    res, errors = sounds.search(spec, kind=kind, limit=8, max_duration=max_duration, min_duration=min_duration)
    ranked = sounds.rank_music(res, target) if kind == "music" and target else res
    got = sounds.fetch_first(ranked, on_error=lambda s, e: print(f"  ! {s.ref} indisponible ({e}), essai suivant", file=sys.stderr))
    if not got:
        why = "; ".join(f"{k}: {v}" for k, v in errors.items()) or ("téléchargements refusés" if res else "aucun résultat")
        raise RuntimeError(f"Aucun son utilisable pour « {spec} » ({why}). Donne un fichier local ou configure une autre banque.")
    pick, path = got
    credits.add(pick)
    print(f"  ♪ {kind:<5} « {spec} » → {pick.title} ({pick.provider}, {pick.license})")
    return path


def _parse_sfx(spec: str) -> tuple[str, str]:
    """'whoosh@cuts', 'pop@1.5,8', 'sons/ding.wav@3' → (source, positions)."""
    if "@" not in spec:
        raise SystemExit(f"SFX invalide « {spec} » : format attendu source@cuts ou source@1.5,8.2")
    src, _, where = spec.rpartition("@")
    return src, where


def _sfx_times(where: str, cut_points: list[float], beats: list[float] | None,
               transitions: list[float] | None = None) -> list[float]:
    if where == "cuts":
        return cut_points
    if where == "transitions":
        return transitions or []
    if where.startswith("beats"):
        every = int(where.split(":")[1]) if ":" in where else 4
        return (beats or [])[::every]
    return [float(x) for x in where.split(",") if x.strip()]


def _resolve_role(role, override: str | None, credits):
    """Son d'un rôle du kit : remplacement donné, sinon dossier local, sinon banques (requêtes dans l'ordre)."""
    from cutkiller import sounds

    if override:
        return _resolve_sound(override, "sfx", credits, max_duration=role.max_duration)
    for providers in (["local"], None):
        for q in role.queries:
            res, _ = sounds.search(q, kind="sfx", providers=providers, limit=8, max_duration=role.max_duration)
            got = sounds.fetch_first(res, on_error=lambda s_, e: None) if res else None
            if got:
                pick, path = got
                credits.add(pick)
                print(f"  ♪ {role.name:<8} « {q} » → {pick.title} ({pick.provider}, {pick.license})")
                return path
    return None


def _kit_cues(a: argparse.Namespace, duration: float, cut_points: list[float], credits, *, clicks: bool | None):
    """Kit de sound design : un son par type d'événement, calé sur son pic ou son attaque."""
    from cutkiller.edit.mixer import SfxCue
    from cutkiller.sounds.kit import KITS, ROLES, hit_time, parse_overrides, plan_events

    kit = KITS[a.sfx_kit]
    overrides = parse_overrides(getattr(a, "kit_sound", None))
    events = plan_events(kit, duration, cut_points, getattr(a, "_transition_events", None) or [], clicks=clicks)
    if not events:
        print(f"  (kit {kit.name} : aucun événement à sonoriser — ajoute des transitions avec --transition)")
        return []
    cues, placed = [], []
    for name in dict.fromkeys(e.role for e in events):
        role = ROLES[name]
        path = _resolve_role(role, overrides.get(name), credits)
        if path is None:
            print(f"  ! kit {kit.name} : aucun son « {name} » trouvé (dossier local ni banques), rôle ignoré",
                  file=sys.stderr)
            continue
        mine = [e for e in events if e.role == name]
        placed.append(f"{name}×{len(mine)}")
        gain = role.gain_db + a.kit_volume
        if name == "ambience":
            for e in mine:
                cues.append(SfxCue(path=path, times=[e.time], gain_db=gain, loop_for=e.length, fade=min(1.0, e.length / 3)))
            continue
        hit = hit_time(path, role.align)
        cues.append(SfxCue(path=path, times=[e.time - hit for e in mine], gain_db=gain))
    print(f"  Kit {kit.name} : " + (", ".join(placed) or "aucun son placé"))
    return cues


def _prepare_mix(a: argparse.Namespace, duration: float, cut_points: list[float], *, music_path: Path | None = None,
                 clicks: bool | None = None):
    """Résout musique + SFX (recherche, téléchargement) AVANT tout rendu : échec rapide."""
    from cutkiller.edit.mixer import MixPlan, MusicBed, SfxCue, spaced
    from cutkiller.media import ANALYSIS_SR, load_audio
    from cutkiller.sounds import Credits

    credits = Credits()
    plan = MixPlan(target_lufs=None if a.no_normalize else a.target_lufs)
    beats = None
    if a.music or music_path:
        mpath = music_path or _resolve_sound(a.music, "music", credits, min_duration=20, target=duration)
        plan.music = MusicBed(path=mpath, gain_db=a.music_volume, duck=not a.no_duck, start_offset=a.music_start)
        if any("@beats" in s for s in a.sfx or []):
            from cutkiller.listen.beats import analyze_beats

            beats = [b - a.music_start for b in analyze_beats(load_audio(mpath, ANALYSIS_SR), ANALYSIS_SR).beats
                     if b >= a.music_start]
    align = getattr(a, "sfx_align", "start")
    for spec in a.sfx or []:
        src, where = _parse_sfx(spec)
        raw = _sfx_times(where, cut_points, beats, getattr(a, "_transition_times", None))
        if align == "start":
            times = spaced([max(0.0, t + a.sfx_offset) for t in raw], a.sfx_spacing)
        else:
            times = spaced(raw, a.sfx_spacing)
        if not times:
            print(f"  (aucune position pour {spec})")
            continue
        path = _resolve_sound(src, "sfx", credits, max_duration=4)
        if align != "start":
            from cutkiller.sounds.kit import hit_time

            hit = hit_time(path, align)
            times = [t - hit for t in times]
        plan.sfx.append(SfxCue(path=path, times=times, gain_db=a.sfx_volume))
    if getattr(a, "sfx_kit", None):
        plan.sfx += _kit_cues(a, duration, cut_points, credits, clicks=clicks)
    return plan, credits


def _finish(out: Path, credits) -> int:
    print(f"Export : {out}")
    cred = credits.write(out.with_suffix(".credits.txt"))
    if cred:
        print(f"Crédits à mettre en description : {cred}")
        print(credits.text())
    return 0


def cmd_mix(a: argparse.Namespace) -> int:
    from cutkiller.edit.mixer import render_mix
    from cutkiller.media import probe

    src = Path(a.input)
    cut_points = [float(x) for x in a.cut_points.split(",")] if a.cut_points else []
    plan, credits = _prepare_mix(a, probe(src).duration, cut_points)
    out = render_mix(src, _out_path(src, "_mix", a.output), plan)
    return _finish(out, credits)


# Finition dans le rendu principal : même qualité d'encodage que les commandes texture/text qu'elle remplace
# (CRF 18 : le grain et les aplats de texte supportent mal un CRF plus élevé).
FINISH_CRF = 18


def _delivery(a: argparse.Namespace, fmt):
    """--platform / --draft → (format de sortie, options d'encodage). Sans eux : inchangé."""
    from cutkiller.transitions.frames import VideoFormat

    enc: dict = {}
    plat = getattr(a, "platform", None)
    if plat:
        from cutkiller import platforms

        p = platforms.get(plat)
        fps = min(fmt.fps if fmt else 30.0, p.max_fps)
        fmt = VideoFormat(p.width, p.height, fps)
        enc.update(platforms.encode_args(p, fps))
        if not getattr(a, "no_normalize", False) and a.target_lufs == -14.0:
            a.target_lufs = p.lufs
        print(f"  Plateforme : {p.label}, {p.width}x{p.height} à {fps:g} i/s, {p.lufs:g} LUFS, "
              f"image clé toutes les {p.gop_seconds:g} s")
    if getattr(a, "draft", False):
        w, h = (fmt.width, fmt.height) if fmt else (1080, 1920)
        k = 540 / min(w, h) if min(w, h) > 540 else 1.0
        fmt = VideoFormat(int(w * k) // 2 * 2, int(h * k) // 2 * 2, fmt.fps if fmt else 30.0)
        enc.update(crf=28, preset="ultrafast")
        enc.pop("gop", None)
        print(f"  Brouillon : {fmt.width}x{fmt.height}, encodage ultrafast (vérifier le montage, pas la qualité)")
    return fmt, enc


def _warn_duration(a: argparse.Namespace, duration: float) -> None:
    if getattr(a, "platform", None):
        from cutkiller import platforms

        msg = platforms.duration_warning(platforms.get(a.platform), duration)
        if msg:
            print(f"  ! {msg}", file=sys.stderr)


def _finish_opts(a: argparse.Namespace, width: int, height: int, duration: float, words=None):
    """--look / --text / --captions → finition appliquée dans l'encodage principal (une seule génération)."""
    from cutkiller.edit.finish import Finish

    fin = Finish()
    if getattr(a, "look", None):
        from cutkiller.edit.texture import LOOKS, TextureSettings

        fin.texture = TextureSettings(**LOOKS[a.look])
    scripts = []
    font_family_name, font_file = None, None
    if getattr(a, "text", None) or words:
        from cutkiller.edit.text import font_family

        font_family_name, font_file = font_family(getattr(a, "font", None) or "Arial")
    if getattr(a, "text", None):
        from cutkiller.edit.text import build_ass, parse_cue

        cues = [parse_cue(t) for t in a.text]
        scripts.append(build_ass(cues, width, height, duration, size=a.text_size, font=font_family_name))
    if words:
        from cutkiller.edit.captions import build_captions_ass

        scripts.append(build_captions_ass(words, width, height, style=a.captions, font=font_family_name))
    fin.ass = scripts or None
    fin.font_file = font_file
    return fin if fin else None


def _caption_words(a: argparse.Namespace, rep, segs):
    """Mots pour --captions : transcription déjà faite (--remove-fillers), --words, <vidéo>.listen.json,
    sinon transcription maintenant. Recalés sur la vidéo montée."""
    if not getattr(a, "captions", None):
        return None
    from cutkiller.edit.captions import load_words
    from cutkiller.edit.finish import remap_words

    words = rep.words
    if not words:
        report = Path(a.words) if getattr(a, "words", None) else Path(a.input).with_suffix(".listen.json")
        if report.exists():
            words = load_words(report)
        else:
            from cutkiller.listen.transcribe import transcribe

            words, _ = transcribe(a.input, a.whisper_model, a.language)
    out = remap_words(words, segs)
    print(f"  Sous-titres : {len(out)} mots, style {a.captions}")
    return out


def cmd_auto(a: argparse.Namespace) -> int:
    from cutkiller.edit.cutlist import output_cut_points, total_duration
    from cutkiller.media import atomic_output
    from cutkiller.edit.mixer import render_mix
    from cutkiller.edit.render import render_cuts

    src = Path(a.input)
    final = _out_path(src, "_cutkiller", a.output)
    print("1/4 Écoute…")
    rep, segs = _plan_cut(a)
    print(f"    {rep.media.duration:.1f} s → {total_duration(segs):.1f} s, {len(segs) - 1} coupes")
    joins = _joins(a, output_cut_points(segs))
    from cutkiller.transitions.frames import VideoFormat

    info = rep.media
    src_fmt = VideoFormat.from_media(info) if info.has_video else None
    fmt, enc = _delivery(a, src_fmt)
    _warn_duration(a, total_duration(segs))
    timeline = dict(enc)
    if fmt is not None and fmt != src_fmt:
        timeline["fmt"] = fmt
    if info.has_video:
        w, h = (fmt or src_fmt).width, (fmt or src_fmt).height
        fin = _finish_opts(a, w, h, total_duration(segs), _caption_words(a, rep, segs))
        if fin:
            timeline["finish"] = fin
            timeline.setdefault("crf", FINISH_CRF)
    print("2/4 Sons…")
    plan, credits = _prepare_mix(a, total_duration(segs), output_cut_points(segs), clicks=False)
    print("3/4 Coupe" + (" + transitions…" if a.transition else "…"))
    # intermédiaire caché, supprimé quoi qu'il arrive ; son en PCM : une seule génération AAC (au mixage)
    cut = final.with_name(f".{final.stem}.cut.mov")  # .mov : PCM + base de temps exacte (mkv arrondit à la ms)
    try:
        with atomic_output(final) as tmp_final:
            render_cuts(src, cut, segs, joins=joins, log=print, audio_codec="pcm", **_punch(a, len(segs), joins),
                        **timeline)
            print("4/4 Mixage…")
            render_mix(cut, tmp_final, plan)
    finally:
        cut.unlink(missing_ok=True)
    return _finish(final, credits)


def _on_strong_beat(t: float, beats: list[float], structure, tol: float) -> bool:
    """La coupe tombe-t-elle sur un premier temps de mesure ou un drop ?"""
    import bisect

    k = bisect.bisect_left(beats, t)
    for j in (k - 1, k):
        if 0 <= j < len(beats) and abs(beats[j] - t) <= tol:
            return structure.strong(j)
    return False


def cmd_montage(a: argparse.Namespace) -> int:
    import tempfile

    from cutkiller.edit.mixer import render_mix
    from cutkiller.edit.montage import MontageSettings, beat_grid, build_montage
    from cutkiller.edit.timeline import Join, plan_timeline, render_timeline
    from cutkiller.listen.beats import analyze_beats
    from cutkiller.media import ANALYSIS_SR, atomic_output, load_audio, probe
    from cutkiller.sounds import Credits
    from cutkiller.transitions.frames import VideoFormat

    inputs = [Path(p) for p in a.inputs]
    for p in inputs:
        if not p.exists():
            raise ValueError(f"Fichier introuvable : {p}")
    first_video = next((p for p in inputs if probe(p).has_video and probe(p).duration > 0.5), None)
    if a.size:
        fmt = VideoFormat.parse_size(a.size, a.fps or 30.0)
    elif first_video:
        fmt = VideoFormat.from_media(probe(first_video), a.fps)
    else:
        fmt = VideoFormat(1080, 1920, a.fps or 30.0)
    if a.size and getattr(a, "platform", None):
        print("  ! --size prime sur le format de --platform", file=sys.stderr)
        size_fmt = fmt
        fmt, enc = _delivery(a, fmt)
        fmt = VideoFormat(size_fmt.width, size_fmt.height, fmt.fps) if not a.draft else fmt
    else:
        fmt, enc = _delivery(a, fmt)
    out = Path(a.output or "montage.mp4")
    credits = Credits()
    music_path, beats, structure, bpc = None, None, None, None
    print("1/4 Musique et rythme…")
    if a.music:
        music_path = _resolve_sound(a.music, "music", credits, min_duration=20, target=a.max_duration or 30)
        music_audio = load_audio(music_path, ANALYSIS_SR)
        info = analyze_beats(music_audio, ANALYSIS_SR)
        beats = beat_grid(info.beats, info.confidence, a.music_start)
        if beats:
            usable = [b for b in info.beats if b >= a.music_start]
            a.music_start = a.music_start + (usable or [0])[0]
            print(f"    {info.bpm:.0f} BPM, coupe tous les {a.beats_per_clip} temps")
            if a.pacing == "energy" or a.transition_on == "strong":
                from cutkiller.listen.beats import music_structure

                structure = music_structure(music_audio, ANALYSIS_SR, usable)
                d0 = structure.downbeats[0] if structure.downbeats else 0
                if 0 < d0 < len(usable) - 4:  # démarrer sur un premier temps : les coupes tombent sur les « 1 »
                    a.music_start += usable[d0] - usable[0]
                    usable = usable[d0:]
                    beats = [b - usable[0] for b in usable]
                    structure = structure.from_beat(d0)
                print(f"    structure : {len(structure.downbeats)} premiers temps de mesure, "
                      f"{len(structure.drops)} montée(s) d'énergie (drops)")
            if a.pacing == "energy":
                from cutkiller.edit.montage import pacing_curve

                bpc = pacing_curve(len(beats), a.beats_per_clip, structure.level)
                print(f"    courbe de rythme : {min(bpc)} à {max(bpc)} temps par clip selon l'énergie")
        else:
            print("    rythme incertain : durée fixe par clip")
    settings = MontageSettings(beats_per_clip=a.beats_per_clip, clip_duration=a.clip_duration,
                               max_duration=a.max_duration, photo_duration=a.photo_duration)
    with tempfile.TemporaryDirectory(prefix="cutkiller_montage_") as work:
        clips = build_montage(inputs, fmt, settings, Path(work), beats, beats_per_clip=bpc)
        if not clips:
            raise ValueError("Aucun clip utilisable.")
        plan = plan_timeline(clips, [Join() for _ in clips[1:]], fmt)
        cut_times = plan.cut_times()
        strong = None
        if structure is not None and a.transition_on == "strong":
            strong = [_on_strong_beat(t, beats, structure, 1.5 / fmt.fps) for t in cut_times]
        joins = _joins(a, cut_times, strong=strong)
        _warn_duration(a, plan.duration)
        print(f"2/4 Plan : {len(clips)} clips, {plan.duration:.1f} s, {len(a._transition_times)} transitions")
        mixplan, mcredits = _prepare_mix(a, plan.duration, cut_times, music_path=music_path)
        for s_ in mcredits.items:
            credits.add(s_)
        if mixplan.music:
            mixplan.music.duck = a.keep_audio and not a.no_duck
        print("3/4 Rendu vidéo…")
        tmp = Path(work) / "timeline.mov"  # son PCM (une seule génération AAC) et base de temps exacte
        fin = _finish_opts(a, fmt.width, fmt.height, plan.duration)
        if fin:
            enc.setdefault("crf", FINISH_CRF)
        render_timeline(clips, joins, tmp, fmt=fmt, fit=a.fit, audio=a.keep_audio, log=print, audio_codec="pcm",
                        finish=fin, **enc)
        print("4/4 Mixage…")
        with atomic_output(out) as tmp_out:
            render_mix(tmp, tmp_out, mixplan)
    return _finish(out, credits)


def _add_mix_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--music", help="fichier audio OU requête (ex. 'lofi chill') cherchée sur les banques")
    p.add_argument("--music-volume", type=float, default=-16.0, help="gain musique en dB (défaut -16)")
    p.add_argument("--music-start", type=float, default=0.0, help="décalage dans le morceau (s)")
    p.add_argument("--no-duck", action="store_true", help="ne pas baisser la musique quand on parle")
    p.add_argument("--sfx", action="append", metavar="SOURCE@POS",
                   help="SFX : 'whoosh@cuts', 'whoosh@transitions', 'pop@2.5,10', 'ding.wav@3', 'hit@beats:4' (répétable)")
    p.add_argument("--sfx-volume", type=float, default=-8.0)
    p.add_argument("--sfx-offset", type=float, default=-0.12, help="décalage des SFX (un whoosh doit précéder la coupe)")
    p.add_argument("--sfx-spacing", type=float, default=1.5, help="écart min entre deux SFX (s)")
    p.add_argument("--sfx-align", choices=["start", "peak", "onset"], default="start",
                   help="point du SFX calé sur la position : start = début du fichier (+ --sfx-offset), "
                        "peak = son maximum (whoosh, riser), onset = attaque (clic, impact, déclencheur)")
    p.add_argument("--sfx-kit", choices=["cinematic", "minimal"],
                   help="sound design automatique : le bon son par événement (whoosh sur les whip/zoom, déclic sur "
                        "les flashs, clic sur les coupes sèches, riser, focus d'ouverture, ambiance de fin), calé sur son pic")
    p.add_argument("--kit-sound", action="append", metavar="RÔLE=SOURCE",
                   help="remplacer un son du kit : 'whoosh=sons/mon_whoosh.wav', 'riser=epic riser' "
                        "(rôles : whoosh, flash, glitch, impact, sparkle, click, riser, focus, ambience)")
    p.add_argument("--kit-volume", type=float, default=0.0, help="gain ajouté à tous les sons du kit (dB)")
    p.add_argument("--target-lufs", type=float, default=-14.0, help="loudness finale (-14 YouTube/TikTok)")
    p.add_argument("--no-normalize", action="store_true")


def _add_delivery_args(p: argparse.ArgumentParser, captions: bool = False) -> None:
    from cutkiller.edit.texture import LOOKS
    from cutkiller.platforms import PLATFORMS

    g = p.add_argument_group("diffusion et finition (appliquées dans le même encodage)")
    g.add_argument("--platform", choices=list(PLATFORMS),
                   help="règle format, cadence max, loudness, qualité d'envoi et images clés pour la plateforme")
    g.add_argument("--draft", action="store_true",
                   help="brouillon rapide (540p, ultrafast) pour vérifier le montage avant le rendu final")
    g.add_argument("--look", choices=list(LOOKS), help="finition (comme « cutkiller texture --look »), sans réencodage")
    g.add_argument("--text", action="append", metavar="TEXTE@DÉBUT-FIN[:position[:couleur[:taille%]]]",
                   help="texte incrusté dans le même encodage (même syntaxe que « cutkiller text »)")
    g.add_argument("--text-size", type=float, default=6.0, help="taille du texte en %% de la hauteur")
    g.add_argument("--font", default="Arial", help="police installée OU fichier .ttf/.otf (texte et sous-titres)")
    if captions:
        g.add_argument("--captions", choices=["tiktok", "bold", "karaoke", "minimal"],
                       help="sous-titres animés recalés sur la vidéo montée (mots : --words, <vidéo>.listen.json "
                            "ou transcription)")
        g.add_argument("--words", help="rapport de « cutkiller listen --transcribe » pour --captions")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="cutkiller", description="Montage vidéo piloté par l'écoute.")
    ap.add_argument("--version", action="version", version=f"cutkiller {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("listen", help="analyse audio : silences, loudness, tempo, transcription")
    p.add_argument("input")
    p.add_argument("-o", "--output", help="rapport JSON (défaut : <input>.listen.json)")
    _add_silence_args(p)
    p.add_argument("--beats", action="store_true", help="détecter tempo / beats / onsets")
    p.add_argument("--transcribe", action="store_true", help="transcrire (faster-whisper) + SRT + hésitations")
    p.add_argument("--whisper-model", default="small")
    p.add_argument("--language", default=None)
    p.add_argument("--target-lufs", type=float, default=-14.0)
    p.set_defaults(func=cmd_listen)

    p = sub.add_parser("cut", help="supprime silences (et hésitations) en jump cuts")
    p.add_argument("input")
    p.add_argument("-o", "--output")
    _add_cut_args(p)
    p.add_argument("--snap-to-onsets", dest="snap_to", action="store_true", help="caler les coupes sur les attaques")
    p.add_argument("--dry-run", action="store_true", help="afficher les segments sans rendre")
    _add_transition_args(p)
    p.set_defaults(func=cmd_cut)

    p = sub.add_parser("mix", help="ajoute musique de fond (ducking) et SFX, normalise")
    p.add_argument("input")
    p.add_argument("-o", "--output")
    p.add_argument("--cut-points", help="positions des coupes pour '@cuts' (ex. 1.2,4.8)")
    _add_mix_args(p)
    p.set_defaults(func=cmd_mix)

    p = sub.add_parser("auto", help="pipeline complet : écoute → coupe → musique + SFX → loudness")
    p.add_argument("input")
    p.add_argument("-o", "--output")
    _add_cut_args(p)
    _add_mix_args(p)
    _add_transition_args(p)
    _add_delivery_args(p, captions=True)
    p.set_defaults(func=cmd_auto, snap_to=False)

    p = sub.add_parser("montage", help="montage de plusieurs vidéos/photos calé sur le rythme de la musique")
    p.add_argument("inputs", nargs="+", help="vidéos et/ou photos, dans l'ordre")
    p.add_argument("-o", "--output", help="défaut : montage.mp4")
    p.add_argument("--size", help="format de sortie, ex. 1080x1920 (vertical), 1920x1080")
    p.add_argument("--fps", type=float, default=None)
    p.add_argument("--fit", choices=["crop", "pad", "stretch"], default="crop", help="adaptation au format")
    p.add_argument("--beats-per-clip", type=int, default=4, help="temps de musique par clip (défaut 4)")
    p.add_argument("--clip-duration", type=float, default=2.0, help="durée par clip sans musique (s)")
    p.add_argument("--photo-duration", type=float, default=3.0)
    p.add_argument("--max-duration", type=float, default=None)
    p.add_argument("--keep-audio", action="store_true", help="garder le son des clips (musique baissée dessous)")
    p.add_argument("--pacing", choices=["fixed", "energy"], default="fixed",
                   help="energy = courbe de rythme : plans plus courts quand la musique pousse, plus longs "
                        "quand elle respire (défaut fixed : --beats-per-clip partout)")
    p.add_argument("--transition-on", choices=["all", "strong"], default="all",
                   help="strong = transitions seulement sur les temps forts (premier temps de mesure, drop), "
                        "coupe franche ailleurs")
    _add_mix_args(p)
    _add_transition_args(p)
    _add_delivery_args(p)
    p.set_defaults(func=cmd_montage)

    tp = sub.add_parser("transitions", help="catalogue, aperçus et galerie des transitions").add_subparsers(
        dest="sub", required=True)
    p = tp.add_parser("list", help="lister (filtrer par famille, thème, mot-clé)")
    p.add_argument("--family", choices=["xfade", "fx", "gl"])
    p.add_argument("--tag")
    p.add_argument("--search")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_transitions_list)
    tp.add_parser("tags", help="thèmes utilisables avec random:<thème>").set_defaults(func=cmd_transitions_tags)
    p = tp.add_parser("info", help="détails et paramètres d'une transition")
    p.add_argument("name")
    p.set_defaults(func=cmd_transitions_info)
    for name, func in (("preview", cmd_transitions_preview), ("gallery", cmd_transitions_gallery)):
        p = tp.add_parser(name, help="aperçu vidéo d'une transition" if name == "preview"
                          else "aperçu de toutes les transitions + page index.html")
        if name == "preview":
            p.add_argument("name")
            p.add_argument("-o", "--output")
            p.add_argument("--a", help="clip A (défaut : mire)")
            p.add_argument("--b", help="clip B (défaut : barres)")
        else:
            p.add_argument("folder")
            p.add_argument("--family", choices=["xfade", "fx", "gl"])
            p.add_argument("--tag")
        p.add_argument("--duration", type=float, default=1.0)
        p.add_argument("--size", default="480x270")
        p.add_argument("--fps", type=float, default=25.0)
        p.set_defaults(func=func)

    p = sub.add_parser("text", help="incruste du texte (accroche, prix, appel à l'action) et/ou des sous-titres .srt")
    p.add_argument("input")
    p.add_argument("-o", "--output")
    p.add_argument("--text", action="append", metavar="TEXTE@DÉBUT-FIN[:position[:couleur[:taille%]]]",
                   help="ex. 'SOLDES -50 %%@0-3:center:yellow', 'Code PUB10@5-' (fin vide = jusqu'à la fin) ; \\n = saut de ligne")
    p.add_argument("--srt", help="graver un fichier de sous-titres (.srt)")
    p.add_argument("--srt-position", choices=["bottom", "center", "top"], default="bottom")
    p.add_argument("--ass", help="graver tel quel un script ASS (animations libass écrites à la main)")
    p.add_argument("--size", type=float, default=6.0, help="taille du texte en %% de la hauteur (défaut 6)")
    p.add_argument("--color", default="white", help="white, yellow, red… ou code hexa RRGGBB")
    p.add_argument("--font", default="Arial", help="nom de police installée OU fichier .ttf/.otf (ex. Fontshare)")
    p.add_argument("--box", action="store_true", help="fond semi-transparent derrière le texte")
    p.add_argument("--outline", type=float, default=0.6, help="épaisseur du contour (0 = aucun)")
    p.add_argument("--fade", type=float, default=0.15, help="fondu d'entrée/sortie du texte (s)")
    p.set_defaults(func=cmd_text)

    p = sub.add_parser("animate", help="crée une animation à fond transparent (préréglage ou script .py sur mesure)")
    p.add_argument("name", nargs="?", help="préréglage (title, kinetic, cta, counter…), script .py ou page .html "
                                        "(motion design HTML/CSS/JS rendu image par image)")
    p.add_argument("params", nargs="*", metavar="clé=valeur", help="ex. text=\"SOLDES -50 %%\" color=yellow")
    p.add_argument("-o", "--output", help=".mov (ProRes 4444 alpha, défaut), .webm (VP9 alpha), .mp4 (fond noir), .png")
    p.add_argument("--size", help="ex. 1080x1920 (défaut), 1920x1080")
    p.add_argument("--like", help="reprendre taille et cadence de cette vidéo")
    p.add_argument("--fps", type=float)
    p.add_argument("--duration", type=float, help="secondes (défaut 3, ou DURATION du script)")
    p.add_argument("--font", help="police .ttf/.otf (sinon Arial/DejaVu/défaut)")
    p.add_argument("--preview", nargs="?", const="", metavar="T1,T2", help="seulement des images clés PNG (vérification rapide)")
    p.add_argument("--list", action="store_true", help="lister les préréglages")
    p.set_defaults(func=cmd_animate)

    p = sub.add_parser("texture", help="finition : look cinématique (étalonnage, lueur, netteté, noirs profonds), "
                                       "grain argentique ou scanné, dither rétro, vignettage, bandes cinéma")
    p.add_argument("input")
    p.add_argument("-o", "--output")
    p.add_argument("--look", choices=["cinematic", "night", "film", "noir", "retro"],
                   help="préréglage complet (les autres options le modifient)")
    p.add_argument("--grade", choices=["teal_orange", "green_orange", "warm", "cold", "bleach", "bw"], help="étalonnage")
    p.add_argument("--contrast", type=float, help="noirs profonds / contraste 0..1")
    p.add_argument("--sharpen", type=float, help="netteté 0..1 (le « 4K » des applis)")
    p.add_argument("--glow", type=float, help="lueur des hautes lumières 0..1 (« luminescence »)")
    p.add_argument("--letterbox", type=float, metavar="RAPPORT", help="bandes cinéma : 2.39, 2.0, 1.85…")
    p.add_argument("--grain", type=float, help="grain procédural 0..1 (0.25 discret, 0.5 marqué)")
    p.add_argument("--grain-file", help="vraie pellicule scannée (vidéo de grain, poussières, rayures), bouclée")
    p.add_argument("--grain-mode", choices=["overlay", "softlight", "screen", "multiply", "addition"],
                   help="fusion du scan : overlay/softlight pour un fond gris 50 %%%%, screen pour un fond noir (défaut overlay)")
    p.add_argument("--grain-opacity", type=float, help="opacité du scan (défaut 0.6)")
    p.add_argument("--dither", choices=["bayer", "floyd_steinberg", "sierra2_4a", "heckbert", "none"],
                   help="trame rétro : bayer = trame ordonnée, floyd_steinberg = diffusion d'erreur")
    p.add_argument("--colors", type=int, help="couleurs de la palette tramée (2 à 256, défaut 16)")
    p.add_argument("--pixel", type=int, help="taille des pixels de la trame (1 = natif, 3-4 = rétro)")
    p.add_argument("--vignette", type=float, help="assombrir les bords 0..1")
    p.set_defaults(func=cmd_texture)

    p = sub.add_parser("overlay", help="incruste animations, logos, images, light leaks à un instant donné")
    p.add_argument("input")
    p.add_argument("-o", "--output")
    p.add_argument("--add", action="append", required=True, metavar="SOURCE@DÉBUT[-FIN]?pos=…&scale=…&mode=…",
                   help="ex. 'titre.mov@0.5', 'logo.png@0-3?pos=top-right&scale=0.2', 'leak.mp4@4?mode=screen'")
    p.set_defaults(func=cmd_overlay)

    p = sub.add_parser("captions", help="sous-titres animés façon TikTok (mot prononcé en surbrillance)")
    p.add_argument("input")
    p.add_argument("-o", "--output")
    p.add_argument("--words", help="rapport de 'cutkiller listen --transcribe' (défaut : <vidéo>.listen.json)")
    p.add_argument("--transcribe", action="store_true", help="transcrire maintenant (faster-whisper)")
    p.add_argument("--whisper-model", default="small")
    p.add_argument("--language")
    p.add_argument("--style", choices=["tiktok", "bold", "karaoke", "minimal"], default="tiktok")
    p.add_argument("--color", default="white")
    p.add_argument("--active", help="couleur du mot prononcé (défaut selon le style)")
    p.add_argument("--size", type=float, help="taille en %% de la hauteur")
    p.add_argument("--position", choices=["bottom", "lower", "center", "top"],
                   help="lower = tiers bas façon TikTok (défaut des styles tiktok/bold)")
    p.add_argument("--max-words", type=int, help="mots maximum par groupe")
    p.add_argument("--font", default="Arial", help="nom de police installée OU fichier .ttf/.otf (ex. Fontshare)")
    p.set_defaults(func=cmd_captions)

    p = sub.add_parser("doctor", help="vérifie l'installation (ffmpeg, OpenGL, options, banques de sons)")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=cmd_doctor)

    sp = sub.add_parser("sounds", help="banques de sons : providers, search, get").add_subparsers(dest="sub", required=True)
    sp.add_parser("providers", help="état des banques configurées").set_defaults(func=cmd_sounds_providers)
    for name, func in (("search", cmd_sounds_search), ("get", cmd_sounds_get)):
        p = sp.add_parser(name, help="chercher" if name == "search" else "télécharger un résultat")
        p.add_argument("query")
        p.add_argument("--kind", choices=["sfx", "music", "any"], default="any")
        p.add_argument("--provider", action="append", help="local, openverse, freesound, jamendo (répétable)")
        p.add_argument("--limit", type=int, default=10)
        p.add_argument("--max-duration", type=float)
        p.add_argument("--min-duration", type=float)
        p.add_argument("--allow-nc", action="store_true", help="inclure les licences NC/ND (usage perso uniquement)")
        if name == "search":
            p.add_argument("--json", action="store_true")
        else:
            p.add_argument("--pick", type=int, default=1, help="numéro du résultat à télécharger")
            p.add_argument("--dest", help="dossier de destination (défaut : cache)")
        p.set_defaults(func=func)
    return ap


def _utf8_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def _stdout_closed() -> bool:
    try:
        sys.stdout.flush()
    except (BrokenPipeError, ValueError):
        return True
    return False


def main(argv: list[str] | None = None) -> int:
    _utf8_console()
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except BrokenPipeError as exc:
        if _stdout_closed():  # `cutkiller ... | head` : fermeture normale du tube
            return 0
        print(f"Erreur : un processus ffmpeg s'est arrêté en cours de route ({exc})", file=sys.stderr)
        return 1
    except (RuntimeError, ValueError, OSError) as exc:
        print(f"Erreur : {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
