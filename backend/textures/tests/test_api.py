import pytest
from django.test import Client
from django.utils import timezone

from textures.models import Texture


def make(slug="polyhaven-red_brick", **overrides):
    data = dict(
        slug=slug,
        name="Red Brick",
        family="brick",
        surface="wall",
        source="polyhaven",
        source_id=slug.split("-", 1)[1],
        source_url=f"https://polyhaven.com/a/{slug.split('-', 1)[1]}",
        tile_width=1.5,
        tile_height=1.5,
        mean_linear=[0.3, 0.1, 0.05],
        lab=[40.0, 30.0, 25.0],
        files={
            "1024": {"color": f"{slug}/abc/color-1024.webp", "normal": f"{slug}/abc/normal-1024.webp", "arm": f"{slug}/abc/arm-1024.webp"},
            "2048": {"color": f"{slug}/abc/color-2048.webp", "normal": f"{slug}/abc/normal-2048.webp", "arm": f"{slug}/abc/arm-2048.webp"},
        },
        thumb=f"{slug}/abc/thumb.webp",
        built_at=timezone.now(),
    ) | overrides
    return Texture.objects.create(**data)


@pytest.mark.django_db
def test_the_manifest_lists_every_enabled_texture_with_its_files():
    make()
    make("ambientcg-Roof01", family="roofTiles", surface="roof", enabled=False)
    response = Client().get("/texture-library/api/manifest")
    assert response.status_code == 200
    assert "max-age=300" in response["Cache-Control"]
    body = response.json()
    assert body["files"] == "/texture-library/files/"
    assert [t["id"] for t in body["textures"]] == ["polyhaven-red_brick"]
    brick = body["textures"][0]
    assert brick["tile"] == [1.5, 1.5]
    assert brick["mean"] == [0.3, 0.1, 0.05]
    assert brick["sizes"]["2048"]["normal"] == "polyhaven-red_brick/abc/normal-2048.webp"
    assert brick["licence"] == "CC0-1.0"


@pytest.mark.django_db
def test_one_texture_and_a_missing_one():
    make()
    assert Client().get("/texture-library/api/textures/polyhaven-red_brick").json()["name"] == "Red Brick"
    assert Client().get("/texture-library/api/textures/nothing").status_code == 404


@pytest.mark.django_db
def test_health():
    make()
    assert Client().get("/texture-library/api/health").json() == {"status": "ok", "textures": 1}


@pytest.mark.django_db
def test_nothing_is_accepted_but_reads():
    assert Client().post("/texture-library/api/manifest", data={}).status_code == 405


@pytest.mark.django_db
def test_the_review_page_needs_staff():
    response = Client().get("/texture-library/review/")
    assert response.status_code == 302
    assert "/admin/login/" in response["Location"]
