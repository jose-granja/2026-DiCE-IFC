"""
Colour measures, exactly as the viewer computes them
(frontend/lib/viewer/realistic/choose.ts and source.ts), so the colours in the
manifest compare with the model's the way the browser's own measures did.
"""

from collections.abc import Iterable

from PIL import Image

Lab = tuple[float, float, float]
Rgb = tuple[float, float, float]


def to_linear(channel: float) -> float:
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def to_srgb(value: float) -> float:
    return value * 12.92 if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055


# 256 entries: every 8-bit value's linear light.
_LINEAR = [to_linear(v / 255) for v in range(256)]


def linear_mean(image: Image.Image) -> Rgb:
    """Mean colour in linear light, as the eye blends a pattern from afar."""
    rgb = image.convert("RGB")
    sums = [0.0, 0.0, 0.0]
    for channel, band in enumerate(rgb.split()):
        histogram = band.histogram()
        sums[channel] = sum(count * _LINEAR[value] for value, count in enumerate(histogram))
    n = rgb.width * rgb.height or 1
    return (sums[0] / n, sums[1] / n, sums[2] / n)


def srgb_to_lab(rgb: Iterable[float]) -> Lab:
    r, g, b = (to_linear(min(1.0, max(0.0, c))) for c in rgb)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t: float) -> float:
        return t ** (1 / 3) if t > 216 / 24389 else (24389 / 27 * t + 16) / 116

    fx, fy, fz = f(x), f(y), f(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def linear_to_lab(mean: Rgb) -> Lab:
    return srgb_to_lab(to_srgb(c) for c in mean)


def delta_e(a: Lab, b: Lab) -> float:
    return sum((x - y) ** 2 for x, y in zip(a, b, strict=True)) ** 0.5


def tile_metres_from_mm(mm: float | None) -> float:
    """Real-world size, clamped as the viewer clamps it (`tileMetresFromMm`)."""
    if not mm or mm < 100:
        return 2.0
    return min(10.0, max(0.25, mm / 1000))
