from django.db import models

from .families import FAMILIES, SURFACES


class Texture(models.Model):
    """One curated texture, built and ready to serve (ADR 016)."""

    SOURCES = [("polyhaven", "Poly Haven"), ("ambientcg", "ambientCG")]

    slug = models.SlugField(primary_key=True, max_length=120, help_text="`source-id`, e.g. polyhaven-concrete_wall_008")
    name = models.CharField(max_length=200)
    family = models.CharField(max_length=32, choices=[(f.id, f.id) for f in FAMILIES], db_index=True)
    surface = models.CharField(max_length=8, choices=[(s, s) for s in SURFACES])
    source = models.CharField(max_length=16, choices=SOURCES)
    source_id = models.CharField(max_length=120)
    source_url = models.URLField()
    licence = models.CharField(max_length=32, default="CC0-1.0")
    tile_width = models.FloatField(help_text="Metres one tile covers across")
    tile_height = models.FloatField(help_text="Metres one tile covers down")
    mean_linear = models.JSONField(help_text="Mean colour, linear RGB 0–1")
    lab = models.JSONField(help_text="Mean colour, CIELAB")
    # {"1024": {"color": "<path>", "normal": "<path>", "arm": "<path>"}, "2048": {…}}, paths under TEXTURE_LIBRARY_ROOT.
    files = models.JSONField()
    thumb = models.CharField(max_length=300)
    note = models.CharField(max_length=300, blank=True)
    enabled = models.BooleanField(default=True, help_text="Off: kept, but not offered to the viewer")
    built_at = models.DateTimeField()

    class Meta:
        ordering = ["family", "slug"]

    def __str__(self) -> str:
        return f"{self.name} ({self.family})"
