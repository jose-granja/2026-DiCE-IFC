import re

from rest_framework import serializers

from . import models

DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")


class ProjectMembershipSerializer(serializers.ModelSerializer):
    user_email = serializers.EmailField(source="user.email", read_only=True)

    class Meta:
        model = models.ProjectMembership
        fields = ["id", "project", "user", "user_email", "role", "created_at"]
        read_only_fields = ["id", "created_at"]


class ProjectSerializer(serializers.ModelSerializer):
    # The requesting user's role in this project, so the frontend does not have
    # to fetch the membership list to decide what to render.
    role = serializers.SerializerMethodField()
    member_count = serializers.IntegerField(
        source="memberships.count", read_only=True
    )

    class Meta:
        model = models.Project
        fields = [
            "id",
            "name",
            "description",
            "signature_audit_enabled",
            "role",
            "member_count",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]

    def get_role(self, obj):
        user = self.context["request"].user
        membership = next(
            (m for m in obj.memberships.all() if m.user_id == user.id), None
        )
        return membership.role if membership else None


class SignatureAuditSerializer(serializers.ModelSerializer):
    user_email = serializers.EmailField(source="user.email", read_only=True)

    class Meta:
        model = models.SignatureAudit
        fields = [
            "id",
            "project",
            "user",
            "user_email",
            "file_name",
            "digest_hex",
            "cert_subject",
            "cert_serial",
            "container",
            "profile",
            "signed_at",
            "recorded_at",
        ]
        read_only_fields = ["id", "user", "user_email", "recorded_at"]

    def validate_digest_hex(self, value):
        # Anything that is not a lowercase SHA-256 hex digest is either a
        # different hash function or a client bug. Both are worth rejecting:
        # the audit log's only value is that every row means the same thing.
        normalised = value.strip().lower()
        if not DIGEST_RE.match(normalised):
            raise serializers.ValidationError(
                "Expected a lowercase SHA-256 digest (64 hex characters)."
            )
        return normalised

    def validate(self, attrs):
        project = attrs.get("project")
        if project is None:
            raise serializers.ValidationError(
                {"project": "An audit row must belong to a project."}
            )
        if not project.signature_audit_enabled:
            # Enforced here rather than trusted to the client: a project that
            # has not opted in must not accumulate rows because a stale tab
            # kept posting them.
            raise serializers.ValidationError(
                {"project": "This project has not enabled the signature audit log."}
            )
        return attrs
