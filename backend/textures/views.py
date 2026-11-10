"""The review page: every texture by family, for curating the selection."""

from django.conf import settings
from django.contrib.admin.views.decorators import staff_member_required
from django.http import HttpRequest, HttpResponse
from django.shortcuts import render

from .families import FAMILIES
from .models import Texture


@staff_member_required
def review(request: HttpRequest) -> HttpResponse:
    by_family = {family.id: [] for family in FAMILIES}
    for texture in Texture.objects.all():
        by_family.setdefault(texture.family, []).append(texture)
    return render(
        request,
        "textures/review.html",
        {"by_family": by_family.items(), "files": settings.TEXTURE_FILES_URL},
    )
