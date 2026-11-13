"""Connecteurs vers les banques de sons via leurs API publiques officielles.

- Openverse : aucune clé, agrège Freesound, Jamendo, ccMixter, Wikimedia… (licences CC)
- Freesound : SFX, clé gratuite via FREESOUND_API_KEY (https://freesound.org/apiv2/apply)
- Jamendo   : musique, client_id gratuit via JAMENDO_CLIENT_ID (https://devportal.jamendo.com)
- Local     : ton propre dossier de sons (CUTKILLER_SOUNDS_DIR), packs achetés inclus
"""

from __future__ import annotations

import re
from pathlib import Path

from cutkiller.sounds.base import Kind, Sound, env, http_json

AUDIO_EXT = {".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac", ".aif", ".aiff", ".opus"}


class OpenverseProvider:
    name = "openverse"
    API = "https://api.openverse.org/v1/audio/"
    MAX_PAGE = 20  # limite des requêtes anonymes

    def available(self) -> bool:
        return True

    def search(self, query, *, kind: Kind = "any", limit=10, max_duration=None, min_duration=None, commercial=True):
        params = {"q": query, "page_size": self.MAX_PAGE, "mature": "false"}
        if commercial:
            # commercial + modification : exclut NC et ND (caler un son sur une vidéo = adaptation)
            params["license_type"] = "commercial,modification"
        results = self.parse(http_json(self.API, {**params, "category": "music"} if kind == "music" else params))
        if kind == "music" and len(results) < limit:
            # beaucoup de morceaux n'ont pas de catégorie renseignée : 2e passe sans filtre
            seen = {s.id for s in results}
            results += [s for s in self.parse(http_json(self.API, params)) if s.id not in seen]
        return _filter(results, limit, max_duration, min_duration)

    @staticmethod
    def parse(data: dict) -> list[Sound]:
        out = []
        for r in data.get("results", []):
            if not r.get("url"):
                continue
            dur = r.get("duration")
            out.append(Sound(
                provider="openverse",
                id=r["id"],
                title=r.get("title") or "sans titre",
                download_url=r["url"],
                duration=dur / 1000.0 if dur else None,  # Openverse renvoie des ms
                license=(r.get("license") or "unknown").lower(),
                license_url=r.get("license_url"),
                creator=r.get("creator"),
                page_url=r.get("foreign_landing_url"),
                tags=[t["name"] for t in r.get("tags") or [] if t.get("name")][:12],
                ext=(r.get("filetype") or "mp3").lower(),
            ))
        return out


class FreesoundProvider:
    name = "freesound"
    API = "https://freesound.org/apiv2/search/text/"
    LICENSES = {
        "Creative Commons 0": "cc0",
        "Attribution": "by",
        "Attribution NonCommercial": "by-nc",
        "Sampling+": "sampling+",
    }

    def __init__(self, token: str | None = None):
        self.token = token or env("FREESOUND_API_KEY")

    def available(self) -> bool:
        return bool(self.token)

    def search(self, query, *, kind: Kind = "any", limit=10, max_duration=None, min_duration=None, commercial=True):
        filters = []
        if max_duration or min_duration:
            filters.append(f"duration:[{min_duration or 0} TO {max_duration or '*'}]")
        if commercial:
            filters.append('license:("Creative Commons 0" OR "Attribution")')
        params = {
            "query": query,
            "token": self.token,
            "page_size": min(limit * 2, 50),
            "fields": "id,name,previews,duration,license,username,url,tags",
            "filter": " ".join(filters) or None,
            "sort": "score",
        }
        return _filter(self.parse(http_json(self.API, params)), limit, max_duration, min_duration)

    @classmethod
    def parse(cls, data: dict) -> list[Sound]:
        out = []
        for r in data.get("results", []):
            previews = r.get("previews") or {}
            url = previews.get("preview-hq-mp3") or previews.get("preview-lq-mp3")
            if not url:
                continue
            lic_url = r.get("license") or ""
            out.append(Sound(
                provider="freesound",
                id=str(r["id"]),
                title=r.get("name") or "sans titre",
                download_url=url,
                duration=r.get("duration"),
                license=_freesound_license(lic_url),
                license_url=lic_url or None,
                creator=r.get("username"),
                page_url=r.get("url"),
                tags=(r.get("tags") or [])[:12],
                ext="mp3",
            ))
        return out


def _freesound_license(url: str) -> str:
    u = url.lower()
    if "publicdomain/zero" in u:
        return "cc0"
    if "by-nc" in u:
        return "by-nc"
    if "sampling" in u:
        return "sampling+"
    if "/by/" in u:
        return "by"
    return FreesoundProvider.LICENSES.get(url, "unknown")


class JamendoProvider:
    name = "jamendo"
    API = "https://api.jamendo.com/v3.0/tracks/"

    def __init__(self, client_id: str | None = None):
        self.client_id = client_id or env("JAMENDO_CLIENT_ID")

    def available(self) -> bool:
        return bool(self.client_id)

    def search(self, query, *, kind: Kind = "any", limit=10, max_duration=None, min_duration=None, commercial=True):
        if kind == "sfx":
            return []
        params = {
            "client_id": self.client_id,
            "format": "json",
            "limit": min(limit * 2, 50),
            "search": query,
            "audioformat": "mp32",
            "include": "musicinfo licenses",
            "order": "relevance",
            "audiodlformat": "mp32",
        }
        if min_duration or max_duration:
            params["durationbetween"] = f"{int(min_duration or 0)}_{int(max_duration or 3600)}"
        sounds = self.parse(http_json(self.API, params))
        if commercial:
            # Jamendo : la majorité du catalogue est en NC → licence pro payante sinon
            sounds = [s for s in sounds if s.commercial_ok]
        return _filter(sounds, limit, max_duration, min_duration)

    @staticmethod
    def parse(data: dict) -> list[Sound]:
        out = []
        for r in data.get("results", []):
            url = r.get("audiodownload") if r.get("audiodownload_allowed") else None
            url = url or r.get("audio")
            if not url:
                continue
            tags = []
            mi = r.get("musicinfo") or {}
            for group in ("genres", "vartags"):
                tags += (mi.get("tags") or {}).get(group, [])
            out.append(Sound(
                provider="jamendo",
                id=str(r["id"]),
                title=r.get("name") or "sans titre",
                download_url=url,
                duration=float(r["duration"]) if r.get("duration") else None,
                license=_cc_from_url(r.get("license_ccurl") or ""),
                license_url=r.get("license_ccurl"),
                creator=r.get("artist_name"),
                page_url=r.get("shareurl"),
                tags=tags[:12],
                ext="mp3",
            ))
        return out


def _cc_from_url(url: str) -> str:
    m = re.search(r"/licenses/([a-z-]+)/", url.lower())
    if m:
        return m.group(1)
    return "cc0" if "publicdomain/zero" in url.lower() else "unknown"


class LocalProvider:
    """Recherche par mots-clés dans les noms de fichiers/dossiers d'une bibliothèque locale."""

    name = "local"

    def __init__(self, root: str | Path | None = None):
        r = root or env("CUTKILLER_SOUNDS_DIR")
        self.root = Path(r).expanduser() if r else None

    def available(self) -> bool:
        return bool(self.root and self.root.is_dir())

    def search(self, query, *, kind: Kind = "any", limit=10, max_duration=None, min_duration=None, commercial=True):
        if not self.available():
            return []
        terms = [t for t in re.split(r"[\s_\-]+", query.lower()) if t]
        scored = []
        for f in self.root.rglob("*"):
            if f.suffix.lower() not in AUDIO_EXT:
                continue
            hay = str(f.relative_to(self.root)).lower()
            score = sum(1 for t in terms if t in hay)
            if kind == "music" and "music" in hay or kind == "sfx" and ("sfx" in hay or "fx" in hay):
                score += 0.5
            if score >= len(terms):
                scored.append((score, f))
        scored.sort(key=lambda x: (-x[0], str(x[1])))
        out = []
        for _, f in scored[: limit * 3]:
            out.append(Sound(provider="local", id=str(f.relative_to(self.root)), title=f.stem, download_url=f.as_uri(),
                             duration=_duration(f), license="local", tags=list(f.relative_to(self.root).parent.parts),
                             ext=f.suffix.lstrip(".").lower()))
        return _filter(out, limit, max_duration, min_duration)


def _duration(path: Path) -> float | None:
    try:
        from cutkiller.media import probe

        return probe(path).duration
    except Exception:  # noqa: BLE001 - fichier illisible : on l'indexe sans durée
        return None


def _filter(sounds: list[Sound], limit: int, max_d: float | None, min_d: float | None) -> list[Sound]:
    out = []
    for s in sounds:
        if s.duration is not None:
            if max_d is not None and s.duration > max_d:
                continue
            if min_d is not None and s.duration < min_d:
                continue
        out.append(s)
    return out[:limit]


def all_providers() -> dict[str, object]:
    return {p.name: p for p in (LocalProvider(), OpenverseProvider(), FreesoundProvider(), JamendoProvider())}
