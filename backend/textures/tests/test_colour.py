import pytest
from PIL import Image

from textures.colour import delta_e, linear_mean, linear_to_lab, srgb_to_lab, tile_metres_from_mm


def test_lab_matches_the_viewers():
    # White, black and mid-grey: CIELAB's anchors, as choose.ts computes them
    # (its rounded matrix leaves white a few thousandths off neutral, as here).
    assert srgb_to_lab((1, 1, 1)) == pytest.approx((100, 0, 0), abs=0.02)
    assert srgb_to_lab((0, 0, 0)) == pytest.approx((0, 0, 0), abs=1e-9)
    assert srgb_to_lab((0.5, 0.5, 0.5))[0] == pytest.approx(53.39, abs=0.01)


def test_the_mean_is_taken_in_linear_light():
    # Half black, half white: linear mean 0.5, which reads as L* 76, not 50.
    image = Image.new("RGB", (2, 1))
    image.putpixel((0, 0), (0, 0, 0))
    image.putpixel((1, 0), (255, 255, 255))
    assert linear_mean(image) == pytest.approx((0.5, 0.5, 0.5))
    assert linear_to_lab(linear_mean(image))[0] == pytest.approx(76.07, abs=0.01)


def test_tile_sizes_are_clamped_as_the_viewer_clamps_them():
    assert tile_metres_from_mm(None) == 2.0
    assert tile_metres_from_mm(50) == 2.0
    assert tile_metres_from_mm(1500) == 1.5
    assert tile_metres_from_mm(30_000) == 10.0
    assert tile_metres_from_mm(120) == 0.25


def test_delta_e():
    assert delta_e((50, 0, 0), (53, 4, 0)) == 5

