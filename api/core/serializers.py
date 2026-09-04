from .models import User
from django.contrib.auth.models import Group, Permission
from djoser.serializers import (
    UserSerializer as BaseUserSerializer,
    # UserCreateSerializer as BaseUserCreateSerializer,
    UserCreatePasswordRetypeSerializer
)
from rest_framework import serializers


class UserCreateSerializer(UserCreatePasswordRetypeSerializer):
    class Meta(UserCreatePasswordRetypeSerializer.Meta):
        model = User
        fields = ['id', 'password',
                  'email', 'first_name', 'last_name']


class UserSerializer(BaseUserSerializer):
    class Meta(BaseUserSerializer.Meta):
        fields = ['id', 'email', 'first_name',
                  'last_name', 'is_staff']

    def update(self, instance, validated_data):
        # When the user changes their email, require re-confirmation: deactivate
        # the account so djoser's perform_update sends an activation email to the
        # new address (djoser only sends it while the user is inactive).
        new_email = validated_data.get('email')
        if new_email and new_email != instance.email:
            instance.is_active = False
        return super().update(instance, validated_data)


# ── Admin (staff-only management) ────────────────────────────────────────────


class GroupSerializer(serializers.ModelSerializer):
    class Meta:
        model = Group
        fields = ['id', 'name']


class PermissionSerializer(serializers.ModelSerializer):
    app_label = serializers.CharField(
        source='content_type.app_label', read_only=True)
    model = serializers.CharField(
        source='content_type.model', read_only=True)
    full_codename = serializers.SerializerMethodField()

    class Meta:
        model = Permission
        fields = ['id', 'name', 'codename', 'app_label',
                  'model', 'full_codename']

    def get_full_codename(self, obj):
        return f"{obj.content_type.app_label}.{obj.codename}"


class AdminUserSerializer(serializers.ModelSerializer):
    groups_detail = GroupSerializer(many=True, read_only=True, source='groups')
    permissions = serializers.SerializerMethodField()
    full_name = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            'id', 'email', 'first_name', 'last_name', 'full_name',
            'is_active', 'is_staff', 'is_superuser',
            'groups', 'groups_detail',
            'user_permissions', 'permissions',
            'last_login', 'date_joined',
        ]
        read_only_fields = [
            'id', 'is_superuser', 'last_login', 'date_joined',
            'groups_detail', 'permissions', 'full_name',
        ]
        extra_kwargs = {
            # All editable from the admin UI, but never required on a PATCH.
            'email': {'required': False},
            'first_name': {'required': False},
            'last_name': {'required': False},
        }

    def get_full_name(self, obj):
        return obj.get_full_name() or obj.email

    def get_permissions(self, obj):
        return sorted(obj.get_all_permissions())

