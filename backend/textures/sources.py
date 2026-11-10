"""
The two CC0 libraries the texture library is built from, read at build time
only (never by a visitor): Poly Haven and ambientCG.

Every download is cached on disk (TEXTURE_CACHE_DIR), so rebuilding fetches
nothing twice. A URL an API returns is data: it is fetched only over https and
only from the libraries' own hosts.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qsl, urlsplit

import requests
from PIL import Image, ImageOps

from .colour import Lab, linear_mean, linear_to_lab, to_linear
from .families import SURFACES, Family

# Not what a building is finished in: proposing these would chase outliers.
NOT_A_FINISH = re.compile(
    r"\b(moss|mossy|rust|rusty|rebar|ruins?|broken|climbing|book|graffiti|leaf|leaves|debris|dirty|damaged|burnt|burned|blood|scratch\w*)\b",
    re.IGNORECASE,
)

HOSTS = {"api.polyhaven.com", "dl.polyhaven.org", "cdn.polyhaven.com", "ambientcg.com", "f003.backblazeb2.com"}
USER_AGENT = "DiCE-IFC texture library builder (https://github.com/jose-granja/2026-DiCE-IFC)"


@dataclass
class Candidate:
    """A texture a family could use, as the proposal sees it."""

    source: str
    id: str
    name: str
    family: str
    surface: str
    lab: Lab | None


@dataclass
class Maps:
    """A texture's maps, as images: colour (sRGB), OpenGL normal, and occlusion/roughness/metalness."""

    color: Image.Image
    normal: Image.Image
    arm: Image.Image


@dataclass
class Details:
    name: str
    page: str
    # Millimetres one tile covers, when the library says.
    width_mm: float | None
    height_mm: float | None


class Source(Protocol):
    id: str

    def candidates(self, family: Family, measure: bool = True) -> list[Candidate]: ...
    def details(self, texture_id: str) -> Details: ...
    def maps(self, texture_id: str, size: int, family: Family) -> Maps: ...


class Downloader:
    def __init__(self, cache_dir: Path, pause: float = 0.2) -> None:
        self.cache_dir = cache_dir
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self.pause = pause

    def _checked(self, url: str) -> str:
        parts = urlsplit(url)
        if parts.scheme != "https" or parts.hostname not in HOSTS:
            raise ValueError(f"Not a library URL: {url}")
        return url

    def bytes(self, url: str, cache: bool = True) -> bytes:
        url = self._checked(url)
        path = self.cache_dir / hashlib.sha256(url.encode()).hexdigest()[:32]
        if cache and path.exists():
            return path.read_bytes()
        response = self._get(url)
        time.sleep(self.pause)  # Politely: these are free services.
        if cache:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(response.content)
        return response.content

    def _get(self, url: str, attempts: int = 4) -> requests.Response:
        """A dropped connection or a busy server is tried again, waiting longer each time."""
        for attempt in range(attempts):
            try:
                response = self.session.get(url, timeout=120)
                if response.status_code < 500 and response.status_code != 429:
                    response.raise_for_status()
                    return response
                error: Exception = requests.HTTPError(f"{response.status_code} for {url}")
            except (requests.ConnectionError, requests.Timeout) as failure:
                error = failure
            if attempt == attempts - 1:
                raise error
            time.sleep(2 ** attempt * 2)
        raise AssertionError("unreachable")

    def json(self, url: str, cache: bool = True) -> Any:
        return json.loads(self.bytes(url, cache=cache))

    def image(self, url: str) -> Image.Image:
        image = Image.open(io.BytesIO(self.bytes(url)))
        image.load()
        return image


def square(image: Image.Image, size: int, mode: str = "RGB") -> Image.Image:
    image = image.convert(mode)
    return image if image.size == (size, size) else image.resize((size, size), Image.Resampling.LANCZOS)


def lab_of(image: Image.Image) -> Lab:
    return linear_to_lab(linear_mean(image))


class PolyHaven:
    """Poly Haven: a catalogue, flat previews to measure, and each map as its own file."""

    id = "polyhaven"
    API = "https://api.polyhaven.com"

    def __init__(self, downloader: Downloader) -> None:
        self.downloader = downloader
        self._catalogue: dict[str, Any] | None = None

    def catalogue(self) -> dict[str, Any]:
        if self._catalogue is None:
            self._catalogue = self.downloader.json(f"{self.API}/assets?t=textures", cache=False)
        return self._catalogue

    @staticmethod
    def usable(asset: dict[str, Any]) -> bool:
        if (asset.get("attributes") or {}).get("aerial"):
            return False
        words = f"{asset.get('name', '')} {asset.get('category', '')} {' '.join(asset.get('categories') or [])}".lower()
        return not re.search(r"\bsnow|\bmoon\b|regolith", words)

    @staticmethod
    def in_family(asset: dict[str, Any], family: Family) -> bool:
        category = asset.get("category") or ""
        tags = set(asset.get("categories") or [])
        # As the viewer matches them (classify.ts `inFamily`).
        on_path = any(category == path or category.startswith(f"{path}/") for path in family.polyhaven_paths)
        return on_path or any(t in tags for t in family.polyhaven_tags)

    def candidates(self, family: Family, measure: bool = True) -> list[Candidate]:
        out = []
        for texture_id, asset in sorted(self.catalogue().items()):
            if not (self.usable(asset) and self.in_family(asset, family)):
                continue
            attributes = asset.get("attributes") or {}
            surface = attributes.get("surface_use")
            words = f"{asset.get('name', '')} {' '.join(asset.get('categories') or [])}"
            if NOT_A_FINISH.search(words) or {"damaged", "dirty"} & set(attributes.get("condition") or []):
                continue
            # Terracotta is roof tiles and floor tiles alike; this family is the roof's.
            if family.id == "roofTiles" and surface != "roof" and "roof" not in asset.get("name", "").lower():
                continue
            lab = None
            if measure:
                try:
                    lab = lab_of(self.downloader.image(f"https://cdn.polyhaven.com/asset_img/primary/{texture_id}.png?width=64"))
                except (requests.RequestException, OSError):
                    lab = None
            out.append(Candidate("polyhaven", texture_id, asset.get("name", texture_id), family.id, surface if surface in SURFACES else family.surface, lab))
        return out

    def details(self, texture_id: str) -> Details:
        asset = self.catalogue().get(texture_id) or self.downloader.json(f"{self.API}/info/{texture_id}")
        w, h = (list(asset.get("dimensions") or []) + [None, None])[:2]
        return Details(asset.get("name", texture_id), f"https://polyhaven.com/a/{texture_id}", w, h or w)

    def maps(self, texture_id: str, size: int, family: Family) -> Maps:
        files = self.downloader.json(f"{self.API}/files/{texture_id}")
        resolution = "2k" if size > 1024 else "1k"

        def get(map_name: str) -> Image.Image:
            url = (((files.get(map_name) or {}).get(resolution) or {}).get("jpg") or {}).get("url")
            if not url:
                raise LookupError(f"Poly Haven has no {resolution} {map_name} for {texture_id}")
            return self.downloader.image(url)

        return Maps(color=get("Diffuse"), normal=get("nor_gl"), arm=get("arm"))


class AmbientCG:
    """
    ambientCG: its API has every asset's colours, size and tags. Its downloads
    are ZIPs of about 10 MB at 1K and 34 MB at 2K, so the maps are read from
    the 2048-pixel surface previews instead, one file each.
    """

    id = "ambientcg"
    API = "https://ambientcg.com/api/v3/assets"
    # The surface an asset's kind usually is, by its id's prefix.
    SURFACE_BY_PREFIX = {
        "WoodFloor": "floor", "WoodSiding": "wall", "Planks": "floor", "Wood": "wall",
        "RoofingTiles": "roof", "PavingStones": "floor", "Road": "floor", "Asphalt": "floor",
        "Bricks": "wall", "PaintedBricks": "wall", "Rocks": "wall", "Tiles": "floor", "Terrazzo": "floor",
        "GlazedTerracotta": "wall", "Plaster": "wall", "PaintedPlaster": "wall", "Concrete": "wall",
        "Metal": "wall", "MetalPlates": "wall", "CorrugatedSteel": "wall", "PaintedMetal": "wall",
        "SheetMetal": "wall", "Marble": "floor", "Granite": "floor", "Travertine": "floor",
        "Gravel": "floor", "Ground": "floor", "Grass": "floor", "Moss": "floor", "Carpet": "floor",
        "Plastic": "floor", "Rubber": "floor",
    }

    def __init__(self, downloader: Downloader) -> None:
        self.downloader = downloader
        self._catalogue: dict[str, Any] | None = None

    def catalogue(self) -> dict[str, Any]:
        if self._catalogue is None:
            assets: dict[str, Any] = {}
            offset = 0
            while True:
                page = self.downloader.json(
                    f"{self.API}?type=material&limit=250&offset={offset}&include=title,tags,colors,dimensions,maps,previews",
                    cache=False,
                )
                for asset in page.get("assets") or []:
                    assets[asset["id"]] = asset
                offset += 250
                if offset >= int(page.get("totalResults") or 0):
                    break
            self._catalogue = assets
        return self._catalogue

    @staticmethod
    def prefix(asset_id: str) -> str:
        return re.sub(r"\d+[A-Z]?$", "", asset_id)

    def in_family(self, asset: dict[str, Any], family: Family) -> bool:
        tags = {t.lower() for t in asset.get("tags") or []}
        maps = set(asset.get("maps") or [])
        return (
            self.prefix(asset["id"]) in family.ambientcg_prefixes
            and not tags & set(family.ambientcg_exclude_tags)
            and not tags & {"snow", "ice"}
            and {"color", "normal"} <= maps
            and self.preview_urls(asset) is not None
        )

    @staticmethod
    def preview_urls(asset: dict[str, Any]) -> dict[str, str] | None:
        """The surface preview's maps, from the viewer link the API gives (`…#color_url=…&normal_url=…`)."""
        for preview in asset.get("previews") or []:
            if preview.get("type") != "pbr-one-material-shading":
                continue
            fragment = urlsplit(preview.get("url", "")).fragment
            fields = dict(parse_qsl(fragment))
            urls = {
                key.removesuffix("_url"): value.split("?")[0]
                for key, value in fields.items()
                if key.endswith("_url")
            }
            if "color" in urls and "normal" in urls:
                urls["normal_type"] = fields.get("normal_type", "directx")
                return urls
        return None

    @staticmethod
    def colour_hint(asset: dict[str, Any]) -> Lab | None:
        """The API's dominant colours, averaged in linear light: close enough to propose with."""
        colours = [c for c in asset.get("colors") or [] if re.fullmatch(r"[0-9A-Fa-f]{6}", c)]
        if not colours:
            return None
        linear = [sum(to_linear(int(c[i : i + 2], 16) / 255) for c in colours) / len(colours) for i in (0, 2, 4)]
        return linear_to_lab(tuple(linear))

    def candidates(self, family: Family, measure: bool = True) -> list[Candidate]:
        out = []
        for asset_id, asset in sorted(self.catalogue().items()):
            if not self.in_family(asset, family):
                continue
            tags = {t.lower() for t in asset.get("tags") or []}
            if NOT_A_FINISH.search(f"{asset.get('title', '')} {' '.join(tags)}"):
                continue
            surface = self.SURFACE_BY_PREFIX.get(self.prefix(asset_id)) or next((s for s in SURFACES if s in tags), family.surface)
            out.append(Candidate("ambientcg", asset_id, asset.get("title") or asset_id, family.id, surface, self.colour_hint(asset)))
        return out

    def details(self, texture_id: str) -> Details:
        asset = self.catalogue().get(texture_id)
        if asset is None:
            raise LookupError(f"ambientCG has no material {texture_id}")
        dims = asset.get("dimensions") or {}
        # Centimetres in ambientCG's API.
        width = dims.get("width")
        height = dims.get("height")
        return Details(
            asset.get("title") or texture_id,
            f"https://ambientcg.com/view?id={texture_id}",
            width * 10 if width else None,
            height * 10 if height else (width * 10 if width else None),
        )

    def maps(self, texture_id: str, size: int, family: Family) -> Maps:
        asset = self.catalogue().get(texture_id)
        urls = self.preview_urls(asset) if asset else None
        if not urls:
            raise LookupError(f"ambientCG lists no maps for {texture_id}")
        color = self.downloader.image(urls["color"])
        normal = self.downloader.image(urls["normal"]).convert("RGB")
        if urls["normal_type"] == "directx":
            # DirectX normals point green down; the viewer reads OpenGL's, up.
            r, g, b = normal.split()
            normal = Image.merge("RGB", (r, ImageOps.invert(g), b))
        side = color.size

        def grey(key: str, fallback: int) -> Image.Image:
            url = urls.get(key)
            if url:
                return self.downloader.image(url).convert("L").resize(side, Image.Resampling.LANCZOS)
            return Image.new("L", side, fallback)

        arm = Image.merge(
            "RGB",
            (
                grey("ambientocclusion", 255),
                grey("roughness", round(family.roughness * 255)),
                grey("metalness", 0),
            ),
        )
        return Maps(color=color, normal=normal, arm=arm)
