"""
Propose textures/selection.json: for each kind of material, a spread of
textures across its colours, from both libraries.

    python manage.py propose_texture_selection           # print what it would pick
    python manage.py propose_texture_selection --write   # and write the file

A starting point to review (the review page, then edit the file), not a
decision: it sees colour, not quality.
"""

import json

from django.conf import settings
from django.core.management.base import BaseCommand

from textures.colour import delta_e
from textures.families import FAMILIES
from textures.sources import AmbientCG, Candidate, Downloader, PolyHaven

# Poly Haven's own map files are lighter to fetch and its textures uniformly
# scanned: given two equally distant colours, prefer it.
POLYHAVEN_PREFERENCE = 1.25


def spread(candidates: list[Candidate], count: int) -> list[Candidate]:
    """Farthest-point sampling in Lab, starting from the most typical colour."""
    measured = [c for c in candidates if c.lab is not None]
    if len(measured) <= count:
        return measured
    mean = tuple(sum(c.lab[i] for c in measured) / len(measured) for i in range(3))
    chosen = [min(measured, key=lambda c: delta_e(c.lab, mean) / (POLYHAVEN_PREFERENCE if c.source == "polyhaven" else 1))]
    while len(chosen) < count:
        def score(c: Candidate) -> float:
            nearest = min(delta_e(c.lab, other.lab) for other in chosen)
            return nearest * (POLYHAVEN_PREFERENCE if c.source == "polyhaven" else 1)

        rest = [c for c in measured if c not in chosen]
        chosen.append(max(rest, key=score))
    return chosen


class Command(BaseCommand):
    help = "Propose a texture selection spread over each family's colours."

    def add_arguments(self, parser):
        parser.add_argument("--write", action="store_true", help=f"Write {settings.TEXTURE_SELECTION.name}.")

    def handle(self, *args, write: bool = False, **options):
        downloader = Downloader(settings.TEXTURE_CACHE_DIR)
        sources = [PolyHaven(downloader), AmbientCG(downloader)]
        selection = []
        seen: set[tuple[str, str]] = set()
        for family in FAMILIES:
            candidates = [c for source in sources for c in source.candidates(family) if (c.source, c.id) not in seen]
            picked = spread(candidates, family.count)
            seen.update((c.source, c.id) for c in picked)
            self.stdout.write(f"{family.id}: {len(picked)} of {len(candidates)} — " + ", ".join(c.name for c in picked))
            selection += [
                {
                    "family": c.family,
                    "source": c.source,
                    "id": c.id,
                    "name": c.name,
                    "surface": c.surface,
                    "note": "proposed by colour spread",
                }
                for c in sorted(picked, key=lambda c: (c.source, c.id))
            ]
        if write:
            settings.TEXTURE_SELECTION.write_text(json.dumps(selection, indent=2, ensure_ascii=False) + "\n")
            self.stdout.write(self.style.SUCCESS(f"Wrote {len(selection)} textures to {settings.TEXTURE_SELECTION}."))
