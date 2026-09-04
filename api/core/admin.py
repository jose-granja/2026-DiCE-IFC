from django.contrib import admin
from unfold.admin import ModelAdmin
from unfold.forms import AdminPasswordChangeForm, UserChangeForm, UserCreationForm

from . import models
# Register your models here.



@admin.register(models.User)
class UserAdmin(ModelAdmin):
    # Forms loaded from `unfold.forms`
    form = UserChangeForm
    add_form = UserCreationForm
    change_password_form = AdminPasswordChangeForm
    list_display = ['id', 'first_name', 'last_name',
                    'email', 'is_staff', 'is_superuser', 'display_groups','is_active']
    sortable_by = ['id', 'first_name', 'last_name', 'email', 'is_active']
    list_filter = ['is_staff', 'is_superuser', 'is_active', 'groups']
    search_fields = ['email']
    
    def display_groups(self, obj):
        return ", ".join([g.name for g in obj.groups.all()])
    display_groups.short_description = "Groups"

