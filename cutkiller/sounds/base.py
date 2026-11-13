"""Modèle commun aux banques de sons."""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from typing import Literal, Protocol

from cutkiller import __version__

Kind = Literal["sfx", "music", "any"]
USER_AGENT = f"CutKiller/{__version__} (+https://github.com/BaldW1N69/CutKiller)"

# licences compatibles avec une vidéo monétisée (usage commercial ET synchronisation/modification)
COMMERCIAL_OK = {"cc0", "pdm", "by", "by-sa", "pixabay", "local"}


@dataclass
class Sound:
    provider: str
    id: str
    title: str
    download_url: str
    duration: float | None = None  # secondes
    license: str = "unknown"
    license_url: str | None = None
    creator: str | None = None
    page_url: str | None = None
    tags: list[str] = field(default_factory=list)
    ext: str = "mp3"

    @property
    def ref(self) -> str:
        return f"{self.provider}:{self.id}"

    @property
    def commercial_ok(self) -> bool:
        return self.license.lower() in COMMERCIAL_OK

    @property
    def needs_attribution(self) -> bool:
        return self.license.lower().startswith("by")

    def attribution(self) -> str:
        who = f" par {self.creator}" if self.creator else ""
        lic = self.license.upper() if self.license not in {"local", "unknown"} else self.license
        url = f" — {self.page_url}" if self.page_url else ""
        lic_url = f" ({self.license_url})" if self.license_url else ""
        return f'"{self.title}"{who} [{self.provider}] — licence {lic}{lic_url}{url}'

    def to_dict(self) -> dict:
        return asdict(self)


class Provider(Protocol):
    name: str

    def available(self) -> bool: ...

    def search(self, query: str, *, kind: Kind = "any", limit: int = 10, max_duration: float | None = None,
               min_duration: float | None = None, commercial: bool = True) -> list[Sound]: ...


def http_json(url: str, params: dict | None = None, timeout: float = 20.0) -> dict:
    if params:
        url = f"{url}?{urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - URL construite par nos providers
        return json.loads(resp.read().decode("utf-8"))


def env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None
