"""
The texture library's API (Django Ninja), under `/texture-library/api/`.

Read only, and nothing in it is about a model: the viewer asks for the whole
manifest once, then chooses textures in the browser from the model's
material names and colours, which never come here (frontend/AGENTS.md §1).
"""

from django.conf import settings
from django.http import HttpRequest, HttpResponse
from django.shortcuts import get_object_or_404
from django.utils.cache import patch_cache_control
from ninja import NinjaAPI, Schema
from ninja.errors import HttpError

from .models import Texture

api = NinjaAPI(
    title="DiCE-IFC texture library",
    version="1",
    description="Curated CC0 textures for realistic materials (ADR 016).",
    urls_namespace="texture-library",
    # The interactive docs only while developing.
    docs_url="/docs" if settings.DEBUG else None,
)


class MapFiles(Schema):
    color: str
    normal: str
    arm: str


class TextureOut(Schema):
    id: str
    name: str
    family: str
    surface: str
    source: str
    sourceUrl: str
    licence: str
    # Metres one tile covers: across, down.
    tile: tuple[float, float]
    # Mean colour: linear RGB 0–1, and CIELAB.
    mean: tuple[float, float, float]
    lab: tuple[float, float, float]
    # Each size's maps, paths relative to `ManifestOut.files`: colour (sRGB),
    # OpenGL normal, and occlusion/roughness/metalness.
    sizes: dict[str, MapFiles]
    thumb: str


class ManifestOut(Schema):
    version: int
    # Where the files are, on this origin: prefix every path in `textures` with it.
    files: str
    textures: list[TextureOut]


class HealthOut(Schema):
    status: str
    textures: int


def texture_out(texture: Texture) -> TextureOut:
    return TextureOut(
        id=texture.slug,
        name=texture.name,
        family=texture.family,
        surface=texture.surface,
        source=texture.source,
        sourceUrl=texture.source_url,
        licence=texture.licence,
        tile=(texture.tile_width, texture.tile_height),
        mean=tuple(texture.mean_linear),
        lab=tuple(texture.lab),
        sizes={size: MapFiles(**maps) for size, maps in texture.files.items()},
        thumb=texture.thumb,
    )


@api.get("/manifest", response=ManifestOut, summary="Every texture the viewer may choose from")
def manifest(request: HttpRequest, response: HttpResponse) -> ManifestOut:
    # Short: a rebuilt library shows within minutes. The files themselves are
    # content-addressed and cached for good (nginx).
    textures = [texture_out(t) for t in Texture.objects.filter(enabled=True)]
    # Not built yet (`build_texture_library`): no library, which the viewer
    # says in so many words, rather than an empty one that matches nothing.
    if not textures:
        raise HttpError(404, "No texture library is installed on this server.")
    patch_cache_control(response, public=True, max_age=300)
    return ManifestOut(version=1, files=settings.TEXTURE_FILES_URL, textures=textures)


@api.get("/textures/{slug}", response=TextureOut, summary="One texture")
def texture(request: HttpRequest, slug: str) -> TextureOut:
    return texture_out(get_object_or_404(Texture, slug=slug, enabled=True))


@api.get("/health", response=HealthOut, summary="Up, and how many textures it offers")
def health(request: HttpRequest) -> HealthOut:
    return HealthOut(status="ok", textures=Texture.objects.filter(enabled=True).count())
