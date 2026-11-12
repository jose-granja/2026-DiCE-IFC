from django.conf import settings
from django.contrib import admin
from django.urls import path, re_path
from django.views.static import serve

from dictionary.api import router as property_names
from textures.api import api
from textures.views import review

P = settings.URL_PREFIX

api.add_router("/property-names", property_names)

urlpatterns = [path(f"{P}api/", api.urls)]

if settings.TEXTURE_SERVE_FILES:
    # Development only: production serves these from nginx, cached for good.
    urlpatterns.append(re_path(rf"^{P}files/(?P<path>.+)$", serve, {"document_root": settings.TEXTURE_LIBRARY_ROOT}))

if settings.TEXTURE_ADMIN:
    urlpatterns += [path(f"{P}admin/", admin.site.urls), path(f"{P}review/", review, name="review")]
