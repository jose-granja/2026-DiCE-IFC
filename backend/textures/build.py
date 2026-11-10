"""
Building one texture of the library: its maps at each size, encoded for the
web, its thumbnail and mean colour, under a content-addressed folder.

The folder name is a hash of what was written, so a rebuilt texture gets new
URLs and every file can be cached by browsers for good.
"""

from __future__ import annotations

import hashlib
import io
import shutil
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from .colour import linear_mean, linear_to_lab, tile_metres_from_mm
from .families import BY_ID, sizes_for
from .sources import Source, square

# WebP: about half a JPEG's size at the same look. Normals are kept finer: their
# errors show as light, not colour.
QUALITY = {"color": 82, "normal": 90, "arm": 85}
THUMB_SIZE = 128
# Bump to rebuild everything when the encoding changes.
ENCODING = "webp-v1"


@dataclass
class Entry:
    """One line of selection.json."""

    source: str
    id: str
    family: str
    surface: str
    note: str = ""

    @property
    def slug(self) -> str:
        return f"{self.source}-{self.id}"

    @classmethod
    def from_json(cls, data: dict) -> Entry:
        if data.get("family") not in BY_ID:
            raise ValueError(f"Unknown family {data.get('family')!r} for {data.get('id')!r}")
        if data.get("surface") not in ("wall", "floor", "roof"):
            raise ValueError(f"Unknown surface {data.get('surface')!r} for {data.get('id')!r}")
        return cls(data["source"], data["id"], data["family"], data["surface"], data.get("note", ""))


@dataclass
class Built:
    name: str
    page: str
    tile: tuple[float, float]
    mean: tuple[float, float, float]
    lab: tuple[float, float, float]
    files: dict[str, dict[str, str]]
    thumb: str


def encode(image: Image.Image, quality: int) -> bytes:
    out = io.BytesIO()
    image.save(out, "WEBP", quality=quality, method=4)
    return out.getvalue()


def build_texture(entry: Entry, source: Source, root: Path) -> Built:
    family = BY_ID[entry.family]
    details = source.details(entry.id)
    outputs: dict[str, bytes] = {}
    files: dict[str, dict[str, str]] = {}
    mean = None

    for size in sizes_for(entry.surface):
        maps = source.maps(entry.id, size, family)
        color = square(maps.color, size)
        if size == 1024:
            # The colour the viewer matches with: all of the 1K map, in linear light.
            mean = linear_mean(color)
            thumb = color.resize((THUMB_SIZE, THUMB_SIZE), Image.Resampling.LANCZOS)
            outputs["thumb.webp"] = encode(thumb, 80)
        names = {}
        for key, image in (("color", color), ("normal", square(maps.normal, size)), ("arm", square(maps.arm, size))):
            name = f"{key}-{size}.webp"
            outputs[name] = encode(image, QUALITY[key])
            names[key] = name
        files[str(size)] = names

    assert mean is not None
    digest = hashlib.sha256(ENCODING.encode())
    for name in sorted(outputs):
        digest.update(name.encode())
        digest.update(outputs[name])
    folder = f"{entry.slug}/{digest.hexdigest()[:12]}"

    target = root / folder
    target.mkdir(parents=True, exist_ok=True)
    for name, data in outputs.items():
        (target / name).write_bytes(data)
    # Earlier builds of this texture: no manifest points at them any more.
    for old in (root / entry.slug).iterdir():
        if old.is_dir() and old.name != target.name:
            shutil.rmtree(old)

    return Built(
        name=details.name,
        page=details.page,
        tile=(tile_metres_from_mm(details.width_mm), tile_metres_from_mm(details.height_mm)),
        mean=mean,
        lab=linear_to_lab(mean),
        files={size: {key: f"{folder}/{name}" for key, name in names.items()} for size, names in files.items()},
        thumb=f"{folder}/thumb.webp",
    )
