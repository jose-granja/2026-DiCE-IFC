"""A stand-in for pyproj in the browser, where PROJ is not built for Pyodide.

Answers exactly what ifc-gherkin-rules asks (GRF002/004/005/007): whether a code
is in EPSG, and a CRS's kind, parts and horizontal axes, from a table generated at
build time by the real pyproj the validation service pins (`epsg-crs.json`:
pyproj 3.7.1, PROJ 9.5.1, EPSG v11.022). `CRS.from_string` accepts what pyproj
was measured to accept — `EPSG:n` in any case, `urn:ogc:def:crs:EPSG::n`, a bare
code, an exact unique CRS name, `EPSG:a+b` — and raises CRSError otherwise.
"""
import json
import os
import re

from .exceptions import CRSError

_TABLE = None
_PROJECTED, _VERTICAL, _COMPOUND, _GEOGRAPHIC = 1, 2, 4, 8


def _table():
    global _TABLE
    if _TABLE is None:
        path = os.environ.get("DICE_EPSG_TABLE", os.path.join(os.path.dirname(__file__), "epsg-crs.json"))
        with open(path, encoding="utf-8") as handle:
            _TABLE = json.load(handle)
    return _TABLE


class Axis:
    def __init__(self, direction, unit_conversion_factor):
        self.direction = direction
        self.unit_conversion_factor = unit_conversion_factor


class CoordinateSystem:
    def __init__(self, axes):
        self.axis_list = [Axis(direction, factor) for direction, factor in axes]


class CRS:
    def __init__(self, flags, axes, subs=(), code=None):
        self._flags = flags
        self._code = code
        self.coordinate_system = CoordinateSystem(axes) if axes else None
        self.sub_crs_list = [CRS(f, a) for f, a in subs]

    is_projected = property(lambda self: bool(self._flags & _PROJECTED))
    is_vertical = property(lambda self: bool(self._flags & _VERTICAL))
    is_compound = property(lambda self: bool(self._flags & _COMPOUND))
    is_geographic = property(lambda self: bool(self._flags & _GEOGRAPHIC))

    def to_epsg(self, *_args, **_kwargs):
        return self._code

    @classmethod
    def from_epsg(cls, code):
        entry = _table()["crs"].get(str(int(code)))
        if entry is None:
            raise CRSError(f"Invalid projection: EPSG:{code}")
        flags, axes, *subs = entry
        return cls(flags, axes, subs[0] if subs else (), int(code))

    @classmethod
    def from_string(cls, text):
        if not isinstance(text, str):
            raise CRSError(f"Invalid projection: {text!r}")
        value = text.strip()
        m = re.fullmatch(r"(?i)epsg:(\d+)\+(\d+)", value)
        if m:
            a, b = cls.from_epsg(m.group(1)), cls.from_epsg(m.group(2))
            crs = cls(a._flags | b._flags | _COMPOUND, None)
            crs.sub_crs_list = [a, b]
            return crs
        m = (re.fullmatch(r"(?i)epsg:(\d+)", value) or re.fullmatch(r"(?i)urn:ogc:def:crs:epsg::(\d+)", value)
             or re.fullmatch(r"(\d+)", value))
        if m:
            return cls.from_epsg(m.group(1))
        code = _table()["names"].get(value)
        if code is not None:
            return cls.from_epsg(code)
        raise CRSError(f"Invalid projection: {value}")

    from_user_input = from_string
