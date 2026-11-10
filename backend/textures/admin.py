from django.contrib import admin
from django.utils.html import format_html

from django.conf import settings

from .models import Texture


@admin.register(Texture)
class TextureAdmin(admin.ModelAdmin):
    list_display = ("preview", "name", "family", "surface", "source", "tile_width", "enabled")
    list_filter = ("family", "surface", "source", "enabled")
    list_editable = ("enabled",)
    search_fields = ("slug", "name", "source_id")
    readonly_fields = ("preview", "mean_linear", "lab", "files", "thumb", "built_at")

    @admin.display(description="")
    def preview(self, texture: Texture) -> str:
        return format_html('<img src="{}{}" width="48" height="48" alt="">', settings.TEXTURE_FILES_URL, texture.thumb)
