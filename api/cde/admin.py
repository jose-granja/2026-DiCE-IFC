from django.contrib import admin
from simple_history.admin import SimpleHistoryAdmin
from unfold.admin import ModelAdmin, TabularInline

from . import models


class ProjectMembershipInline(TabularInline):
    model = models.ProjectMembership
    extra = 0
    autocomplete_fields = ["user"]


@admin.register(models.Project)
class ProjectAdmin(ModelAdmin, SimpleHistoryAdmin):
    list_display = ["name", "signature_audit_enabled", "created_at"]
    list_filter = ["signature_audit_enabled"]
    search_fields = ["name", "description"]
    inlines = [ProjectMembershipInline]


@admin.register(models.ProjectMembership)
class ProjectMembershipAdmin(ModelAdmin, SimpleHistoryAdmin):
    list_display = ["project", "user", "role", "created_at"]
    list_filter = ["role"]
    search_fields = ["project__name", "user__email"]
    autocomplete_fields = ["project", "user"]


@admin.register(models.SignatureAudit)
class SignatureAuditAdmin(ModelAdmin):
    list_display = [
        "file_name",
        "user",
        "project",
        "container",
        "profile",
        "signed_at",
    ]
    list_filter = ["container", "profile", "project"]
    search_fields = ["file_name", "digest_hex", "cert_subject", "cert_serial"]
    date_hierarchy = "signed_at"

    # Append-only in the API, append-only here: the model refuses updates, so
    # offering an edit form would only produce a 500 on save.
    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
