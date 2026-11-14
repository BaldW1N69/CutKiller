"""Animations HTML (CSS, JS, canvas, SVG, WebGL) rendues image par image dans un Chromium sans écran.

C'est le format de la plupart des prompts de motion design pour Claude (galeries type Prompt Motion :
« un seul fichier HTML où chaque image est calculée à partir du temps »). CutKiller pilote l'horloge
de la page au lieu de filmer l'écran : rendu exact, sans saccade, quelle que soit la machine.

Pilotage du temps, du plus fiable au plus général :
1. la page définit `window.cutkillerSeek(t)` (t en secondes) : CutKiller l'appelle à chaque image ;
2. sinon l'horloge de la page est simulée (Date, performance.now, requestAnimationFrame, setTimeout)
   et avancée image par image ; les animations CSS / Web Animations sont calées sur t.

Durée : --duration, sinon `window.DURATION` ou `<meta name="duration" content="4">`, sinon la fin des
animations CSS, sinon 5 s. Avant le chargement, la page reçoit `window.CUTKILLER = {width, height, fps,
duration}`. Fond transparent si la page ne peint pas de fond (body { background: transparent }).

Dépendance : pip install 'cutkiller[html]' (Playwright) puis `playwright install chromium`, ou un
Chromium existant via CUTKILLER_CHROMIUM=/chemin/vers/chrome.
"""

from __future__ import annotations

import io
import os
from pathlib import Path

import numpy as np
from PIL import Image

INIT_JS = """
window.CUTKILLER = %s;
"""

SEEK_JS = """
t => {
  if (typeof window.cutkillerSeek === 'function') { window.cutkillerSeek(t); return true; }
  for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000; }
  return false;
}
"""

DURATION_JS = """
() => {
  if (typeof window.DURATION === 'number') return window.DURATION;
  const m = document.querySelector('meta[name="duration"]');
  if (m && !isNaN(parseFloat(m.content))) return parseFloat(m.content);
  let end = 0;
  for (const a of document.getAnimations()) {
    const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
    if (t && isFinite(t.endTime)) end = Math.max(end, t.endTime);
  }
  return end > 0 ? end / 1000 : null;
}
"""


def available() -> bool:
    try:
        import playwright.sync_api  # noqa: F401
    except ImportError:
        return False
    return True


def _launch(pw):
    exe = os.environ.get("CUTKILLER_CHROMIUM")
    try:
        return pw.chromium.launch(executable_path=exe) if exe else pw.chromium.launch()
    except Exception as exc:  # noqa: BLE001 - message d'installation lisible
        raise RuntimeError(
            "Chromium introuvable pour le rendu HTML : lance `playwright install chromium`, "
            "ou indique un Chrome/Chromium existant avec CUTKILLER_CHROMIUM=/chemin/vers/chrome. "
            f"({type(exc).__name__}: {str(exc).splitlines()[0] if str(exc) else ''})"
        ) from exc


class HtmlScene:
    """Une page HTML vue comme une fonction frame(t, ctx) → image RGBA (compatible avec animate.render/stills).

    Les temps croissants avancent l'horloge simulée ; un retour en arrière recharge la page (horloge à zéro)."""

    def __init__(self, path: str | Path, width: int, height: int, fps: float, duration: float | None = None,
                 params: dict | None = None):
        if not available():
            raise RuntimeError("Rendu HTML : installe Playwright (pip install 'cutkiller[html]').")
        from playwright.sync_api import sync_playwright

        self.path = Path(path).expanduser().resolve()
        if not self.path.exists():
            raise ValueError(f"Fichier HTML introuvable : {self.path}")
        self.w, self.h, self.fps = width, height, fps
        self.params = params or {}
        self._pw = sync_playwright().start()
        try:
            self._browser = _launch(self._pw)
            self._page = None
            self._load(duration)
            self.duration = float(duration or self._detect_duration() or 5.0)
        except Exception:
            self.close()
            raise

    # -------------------------------------------------------------- page
    def _load(self, duration: float | None) -> None:
        import json

        if self._page is not None:
            self._page.close()
        page = self._browser.new_page(viewport={"width": self.w, "height": self.h}, device_scale_factor=1)
        info = {"width": self.w, "height": self.h, "fps": self.fps, "duration": duration, "params": self.params}
        page.add_init_script(INIT_JS % json.dumps(info))
        page.clock.install(time=0)
        page.clock.pause_at(0)  # le temps ne s'écoule que lorsque CutKiller l'avance
        page.goto(self.path.as_uri(), wait_until="load")
        page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true")
        self._page, self._ms = page, 0

    def _detect_duration(self) -> float | None:
        return self._page.evaluate(DURATION_JS)

    def _advance(self, t: float) -> None:
        ms = int(round(t * 1000))
        if ms < self._ms:
            self._load(self.duration)
        if ms > self._ms:
            self._page.clock.run_for(ms - self._ms)
            self._ms = ms
        self._page.evaluate(SEEK_JS, t)

    # -------------------------------------------------------------- API frame(t, ctx)
    def __call__(self, t: float, ctx=None) -> np.ndarray:
        self._advance(max(0.0, t))
        png = self._page.screenshot(omit_background=True, type="png")
        return np.asarray(Image.open(io.BytesIO(png)).convert("RGBA"))

    def close(self) -> None:
        for obj, meth in ((getattr(self, "_browser", None), "close"), (getattr(self, "_pw", None), "stop")):
            if obj is not None:
                try:
                    getattr(obj, meth)()
                except Exception:  # noqa: BLE001
                    pass

    def __enter__(self) -> "HtmlScene":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
