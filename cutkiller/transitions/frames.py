"""Lecture / écriture d'images brutes (rgb24) via ffmpeg, avec un format de sortie commun."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from cutkiller.media import MediaInfo, _require, probe


@dataclass(frozen=True)
class VideoFormat:
    width: int
    height: int
    fps: float

    @property
    def ratio(self) -> float:
        return self.width / self.height

    @classmethod
    def parse_size(cls, size: str, fps: float) -> "VideoFormat":
        w, h = (int(v) for v in size.lower().split("x"))
        return cls(w - w % 2, h - h % 2, fps)

    @classmethod
    def from_media(cls, info: MediaInfo, fps: float | None = None) -> "VideoFormat":
        w, h = info.width or 1280, info.height or 720
        f = fps or info.fps or 30.0
        return cls(w - w % 2, h - h % 2, round(f, 3))


# Matrice YUV : celle que les lecteurs supposent pour une vidéo non étiquetée de cette taille, BT.709 en HD
# (plus petit côté >= 720), BT.601 en SD. Toute conversion RGB <-> YUV l'utilise explicitement : sans ça
# swscale prend BT.601 partout, et une source HD de smartphone lue en RGB pour une transition fx/GL puis
# réencodée changeait de teinte pendant la transition (luma 124 -> 110 sur un vert), les photos étaient
# décalées jusqu'à 19 niveaux. YUV -> YUV : aucune conversion, le filtre laisse passer les images.
# Arrondis précis : l'aller-retour YUV -> RGB -> YUV redonne exactement les mêmes valeurs.


def matrix(width: int, height: int) -> str:
    return "bt709" if min(width, height) >= 720 else "bt601"


def rgb_yuv(width: int, height: int) -> str:
    m = matrix(width, height)
    return (f"scale=in_color_matrix={m}:out_color_matrix={m}:out_range=tv:"
            "flags=accurate_rnd+full_chroma_int+full_chroma_inp")


def color_tags(width: int, height: int) -> list[str]:
    """Étiquettes de sortie : BT.709 explicite en HD ; en SD on laisse la valeur par défaut des lecteurs."""
    if matrix(width, height) != "bt709":
        return []
    return ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]


def norm_chain(fmt: VideoFormat, fit: str = "crop", pix_fmt: str = "yuv420p") -> str:
    """Normalise n'importe quelle source vers le format de sortie (taille, cadence, pixels)."""
    w, h = fmt.width, fmt.height
    # Sortie RGB (fenêtres de transition) : conversion explicite, arrondis précis. Sortie YUV : rien à
    # ajouter (YUV -> YUV ne convertit pas ; une option de matrice sur ce scale le ferait passer par un
    # chemin 2x plus lent, mesuré).
    rgb = pix_fmt.startswith(("rgb", "bgr", "gbr"))
    if fit == "pad":
        scale = (f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
                 f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black")
    elif fit == "stretch":
        scale = f"scale={w}:{h}"
    else:
        scale = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"
    conv = f",{rgb_yuv(w, h)}" if rgb else ""
    return f"setpts=PTS-STARTPTS,fps={fmt.fps},{scale},setsar=1{conv},format={pix_fmt}"


def seek_args(start_frame: int, fps: float, preroll: float = 1.0) -> tuple[list[str], int]:
    """Seek rapide un peu avant la cible, puis sélection exacte de la frame en filtre.

    Retourne (arguments d'entrée, frame à sauter après normalisation)."""
    t = start_frame / fps
    pre = min(preroll, t)
    k0 = int(round((t - pre) * fps))
    return (["-ss", f"{k0 / fps:.6f}"] if k0 > 0 else []), start_frame - k0


def read_window(src: str | Path, start_frame: int, n: int, fmt: VideoFormat, fit: str = "crop",
                alpha: bool = False) -> np.ndarray:
    """Lit `n` frames à partir de `start_frame` (dans la cadence `fmt.fps`). Complète par la dernière frame."""
    ch = 4 if alpha else 3
    pix = "rgba" if alpha else "rgb24"
    seek, skip = seek_args(start_frame, fmt.fps)
    vf = f"{norm_chain(fmt, fit, pix)},trim=start_frame={skip},setpts=PTS-STARTPTS"
    cmd = [_require("ffmpeg"), "-nostdin", "-v", "error", *seek, "-i", str(src), "-an", "-vf", vf,
           "-frames:v", str(n), "-f", "rawvideo", "-pix_fmt", pix, "-"]
    out = subprocess.run(cmd, capture_output=True)
    if out.returncode != 0:
        raise RuntimeError(f"Lecture des images impossible ({src}) : {out.stderr.decode(errors='replace')[-800:]}")
    size = fmt.width * fmt.height * ch
    count = len(out.stdout) // size
    frames = np.frombuffer(out.stdout[: count * size], dtype=np.uint8).reshape(count, fmt.height, fmt.width, ch)
    if count == 0:
        frames = np.zeros((1, fmt.height, fmt.width, ch), dtype=np.uint8)
    if count < n:
        frames = np.concatenate([frames, np.repeat(frames[-1:], n - frames.shape[0], axis=0)])
    return frames[:n]


def read_all(src: str | Path, fmt: VideoFormat, fit: str = "stretch", alpha: bool = False) -> np.ndarray:
    info = probe(src)
    n = max(1, int(round(info.duration * fmt.fps)))
    return read_window(src, 0, n, fmt, fit, alpha=alpha)


# Intermédiaires (fenêtres de transition) : x264 sans perte en 4:2:0. Avant : CRF 12, soit une
# génération de pertes de plus sur chaque transition, réencodée ensuite dans le rendu final.
# ultrafast : l'intermédiaire ne vit que le temps du rendu, la taille importe peu.
LOSSLESS = ["-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]


class FrameWriter:
    """Encode des frames rgb24 en vidéo intermédiaire sans perte."""

    def __init__(self, path: str | Path, fmt: VideoFormat):
        self.path = Path(path)
        self.fmt = fmt
        self.proc = subprocess.Popen(
            [_require("ffmpeg"), "-nostdin", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
             "-s", f"{fmt.width}x{fmt.height}", "-r", str(fmt.fps), "-i", "-",
             "-vf", f"{rgb_yuv(fmt.width, fmt.height)},format=yuv420p", *LOSSLESS,
             *color_tags(fmt.width, fmt.height), str(self.path)],
            stdin=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def write(self, frame: np.ndarray) -> None:
        try:
            self.proc.stdin.write(np.ascontiguousarray(frame[..., :3], dtype=np.uint8).tobytes())
        except (BrokenPipeError, OSError) as exc:
            # ffmpeg died (disk full, bad path…): surface its own error instead of a bare EPIPE,
            # which the CLI would otherwise mistake for a closed stdout and exit 0.
            self.proc.kill()
            err = self.proc.stderr.read().decode(errors="replace")
            self.proc.wait()
            raise RuntimeError(f"Encodage de la transition impossible ({self.path.name}) : {err[-800:] or exc}") from exc

    def __enter__(self) -> "FrameWriter":
        return self

    def __exit__(self, exc_type, *_):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        err = self.proc.stderr.read().decode(errors="replace")
        code = self.proc.wait()
        if code != 0 and exc_type is None:
            raise RuntimeError(f"Encodage de la transition impossible : {err[-800:]}")
        return False
