"""A texture source with no network: maps drawn on the spot."""

from PIL import Image

from textures.families import Family
from textures.sources import Candidate, Details, Maps


class FakeSource:
    id = "polyhaven"

    def __init__(self, colour=(200, 60, 40), size_mm=(1500, 1500)):
        self.colour = colour
        self.size_mm = size_mm
        self.asked: list[tuple[str, int]] = []

    def candidates(self, family: Family, measure: bool = True) -> list[Candidate]:
        return []

    def details(self, texture_id: str) -> Details:
        return Details(f"Fake {texture_id}", f"https://polyhaven.com/a/{texture_id}", *self.size_mm)

    def maps(self, texture_id: str, size: int, family: Family) -> Maps:
        self.asked.append((texture_id, size))
        side = 2048 if size > 1024 else 1024
        return Maps(
            color=Image.new("RGB", (side, side), self.colour),
            normal=Image.new("RGB", (side, side), (128, 128, 255)),
            arm=Image.new("RGB", (side, side), (255, 200, 0)),
        )
