"""
The IFC property names in one language, under `/texture-library/api/property-names/`.

Read only, and nothing in a request is about a model: the viewer asks for a
whole language's table once and labels properties in the browser (ADR 017,
frontend/AGENTS.md §1).
"""

import re
from django.http import HttpRequest, HttpResponse
from django.utils.cache import patch_cache_control
from ninja import Router, Schema
from ninja.errors import HttpError

from .bsdd import table

router = Router(tags=["property names"])

# bSDD's codes: `pt-PT`, `EN`, `mn-Cyrl-MN`.
LANGUAGE = re.compile(r"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$")


class PropertyNamesOut(Schema):
    version: int
    language: str
    # The bSDD dictionary the names were read from.
    dictionary: str
    # ISO 8601, UTC, to the second.
    updatedAt: str
    # IFC property name (`FireRating`) → its name in `language`. Only the names
    # bSDD translated; the rest are left out.
    names: dict[str, str]


@router.get("/{language}", response=PropertyNamesOut, summary="IFC property names in one language")
def property_names(request: HttpRequest, response: HttpResponse, language: str) -> dict:
    data = table(language) if LANGUAGE.fullmatch(language) else None
    # None read from bSDD yet: the viewer then uses the copy it ships with.
    if data is None:
        raise HttpError(404, f"No property names in {language} on this server.")
    # Short, like the texture manifest: an update shows within minutes.
    patch_cache_control(response, public=True, max_age=300)
    return data
