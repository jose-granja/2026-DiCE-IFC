import json

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from PIL import Image

from textures import build as build_module
from textures.build import Entry, build_texture
from textures.families import FAMILIES, sizes_for
from textures.models import Texture
from textures.tests.fakes import FakeSource


def entry(**overrides):
    data = {"source": "polyhaven", "id": "red_brick", "family": "brick", "surface": "wall"} | overrides
    return Entry.from_json(data)


def test_walls_and_floors_get_2k_too_and_roofs_1k():
    assert sizes_for("wall") == (1024, 2048)
    assert sizes_for("floor") == (1024, 2048)
    assert sizes_for("roof") == (1024,)


def test_families_are_the_viewers_sixteen():
    assert len({f.id for f in FAMILIES}) == 16


def test_a_selection_line_must_name_a_known_family_and_surface():
    with pytest.raises(ValueError):
        entry(family="lava")
    with pytest.raises(ValueError):
        entry(surface="ceiling")


def test_builds_every_size_under_a_content_addressed_folder(tmp_path):
    source = FakeSource()
    built = build_texture(entry(), source, tmp_path)
    assert set(built.files) == {"1024", "2048"}
    folder = built.thumb.rsplit("/", 1)[0]
    assert folder.startswith("polyhaven-red_brick/")
    for maps in built.files.values():
        assert set(maps) == {"color", "normal", "arm"}
        for path in maps.values():
            assert path.startswith(folder) and path.endswith(".webp")
            assert (tmp_path / path).exists()
    with Image.open(tmp_path / built.files["2048"]["color"]) as image:
        assert image.size == (2048, 2048)
    assert built.tile == (1.5, 1.5)
    assert built.name == "Fake red_brick"


def test_measures_the_colour_from_the_1k_map(tmp_path):
    built = build_texture(entry(surface="roof"), FakeSource(colour=(255, 255, 255)), tmp_path)
    assert built.mean == pytest.approx((1, 1, 1))
    assert built.lab[0] == pytest.approx(100, abs=1e-4)
    assert set(built.files) == {"1024"}


def test_a_rebuild_with_new_pixels_moves_to_a_new_folder_and_drops_the_old(tmp_path):
    first = build_texture(entry(), FakeSource(colour=(10, 10, 10)), tmp_path)
    second = build_texture(entry(), FakeSource(colour=(240, 240, 240)), tmp_path)
    assert first.thumb != second.thumb
    assert not (tmp_path / first.thumb).exists()
    assert (tmp_path / second.thumb).exists()


@pytest.fixture
def library(tmp_path, settings, monkeypatch):
    selection = tmp_path / "selection.json"
    selection.write_text(
        json.dumps(
            [
                {"source": "polyhaven", "id": "red_brick", "family": "brick", "surface": "wall", "note": "warm"},
                {"source": "polyhaven", "id": "clay_roof", "family": "roofTiles", "surface": "roof"},
            ]
        )
    )
    settings.TEXTURE_SELECTION = selection
    settings.TEXTURE_LIBRARY_ROOT = tmp_path / "library"
    settings.TEXTURE_CACHE_DIR = tmp_path / "cache"
    fake = FakeSource()
    monkeypatch.setattr("textures.management.commands.build_texture_library.PolyHaven", lambda downloader: fake)
    return fake


@pytest.mark.django_db
def test_the_command_builds_the_selection_once(library):
    call_command("build_texture_library")
    assert Texture.objects.count() == 2
    brick = Texture.objects.get(slug="polyhaven-red_brick")
    assert brick.note == "warm"
    assert set(brick.files) == {"1024", "2048"}
    assert len(library.asked) == 3  # brick at 1K and 2K, the roof at 1K

    call_command("build_texture_library")
    assert len(library.asked) == 3  # nothing again

    call_command("build_texture_library", "--force", "--only", "polyhaven-clay_roof")
    assert library.asked[-1] == ("clay_roof", 1024)


@pytest.mark.django_db
def test_a_texture_taken_out_of_the_selection_is_switched_off(library, settings):
    call_command("build_texture_library")
    settings.TEXTURE_SELECTION.write_text(json.dumps([{"source": "polyhaven", "id": "red_brick", "family": "brick", "surface": "wall"}]))
    call_command("build_texture_library")
    assert not Texture.objects.get(slug="polyhaven-clay_roof").enabled
    assert Texture.objects.get(slug="polyhaven-red_brick").enabled


@pytest.mark.django_db
def test_one_failure_does_not_stop_the_rest(library, monkeypatch):
    real = build_module.build_texture

    def flaky(entry, source, root):
        if entry.id == "red_brick":
            raise LookupError("no 2k Diffuse")
        return real(entry, source, root)

    monkeypatch.setattr("textures.management.commands.build_texture_library.build_texture", flaky)
    with pytest.raises(CommandError, match="polyhaven-red_brick"):
        call_command("build_texture_library")
    assert Texture.objects.filter(slug="polyhaven-clay_roof").exists()
