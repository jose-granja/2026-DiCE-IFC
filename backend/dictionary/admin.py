from django.conf import settings
from django.contrib import admin, messages
from django.http import HttpRequest, HttpResponseRedirect
from django.urls import path, reverse
from django.utils import timezone

from .bsdd import RefreshBusy, start_refresh
from .models import PropertyName, PropertyNameRefresh


class RefreshButton:
    """The "Update from bSDD" button on a change list, and what it starts."""

    change_list_template = "admin/dictionary/change_list_refresh.html"

    def changelist_view(self, request, extra_context=None):
        extra_context = {**(extra_context or {}), "property_name_languages": ", ".join(settings.PROPERTY_NAME_LANGUAGES)}
        return super().changelist_view(request, extra_context)


@admin.register(PropertyName)
class PropertyNameAdmin(RefreshButton, admin.ModelAdmin):
    list_display = ("code", "name", "override", "english", "language", "updated_at")
    list_editable = ("override",)
    list_filter = ("language",)
    search_fields = ("code", "name", "english", "override")
    readonly_fields = ("language", "code", "name", "english", "uri", "updated_at")
    fields = ("language", "code", "english", "name", "override", "uri", "updated_at")

    def has_add_permission(self, request: HttpRequest) -> bool:
        # Rows come from bSDD; an override is how a name is changed.
        return False

    def save_model(self, request, obj, form, change):
        obj.updated_at = timezone.now()
        super().save_model(request, obj, form, change)

    def get_urls(self):
        return [
            path("refresh/", self.admin_site.admin_view(self.refresh_view), name="dictionary_propertyname_refresh"),
            *super().get_urls(),
        ]

    def refresh_view(self, request: HttpRequest):
        if request.method == "POST" and self.has_change_permission(request):
            for language in settings.PROPERTY_NAME_LANGUAGES:
                try:
                    refresh = start_refresh(language, request.user.get_username())
                except RefreshBusy as busy:
                    messages.warning(request, str(busy))
                    continue
                if refresh.status == PropertyNameRefresh.FAILED:
                    messages.error(request, f"{language}: {refresh.error}")
                elif refresh.status == PropertyNameRefresh.DONE:
                    messages.success(request, f"{language}: {refresh.translated} of {refresh.total} properties have a name.")
                else:
                    messages.info(request, f"Updating {language} from bSDD. Reload this page to see how it went.")
        return HttpResponseRedirect(reverse("admin:dictionary_propertynamerefresh_changelist"))


@admin.register(PropertyNameRefresh)
class PropertyNameRefreshAdmin(RefreshButton, admin.ModelAdmin):
    list_display = ("created_at", "language", "status", "translated", "total", "added", "changed", "removed", "requested_by", "finished_at", "error")
    list_filter = ("status", "language")
    readonly_fields = [field.name for field in PropertyNameRefresh._meta.fields]

    def has_add_permission(self, request: HttpRequest) -> bool:
        return False

    def has_change_permission(self, request: HttpRequest, obj=None) -> bool:
        return False
