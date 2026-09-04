from django.db.models import Prefetch
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import mixins, status
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.viewsets import GenericViewSet, ModelViewSet

from . import models, pagination, serializers


class ProjectViewSet(ModelViewSet):
    """Projects the requesting user is a member of.

    There is no "all projects" listing: membership is the only way in, and a
    project you are not a member of should not be discoverable.
    """

    serializer_class = serializers.ProjectSerializer
    permission_classes = [IsAuthenticated]
    pagination_class = pagination.DefaultPagination
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ["signature_audit_enabled"]

    def get_queryset(self):
        return (
            models.Project.objects.filter(memberships__user=self.request.user)
            .prefetch_related(
                # `ProjectSerializer.get_role` reads the requesting user's
                # membership; prefetching just that one keeps the list endpoint
                # at two queries instead of one per project.
                Prefetch(
                    "memberships",
                    queryset=models.ProjectMembership.objects.filter(
                        user=self.request.user
                    ),
                )
            )
            .distinct()
        )

    def perform_create(self, serializer):
        project = serializer.save()
        models.ProjectMembership.objects.create(
            project=project,
            user=self.request.user,
            role=models.ProjectMembership.Role.OWNER,
        )


class ProjectMembershipViewSet(ModelViewSet):
    """Membership of projects the requesting user can manage."""

    serializer_class = serializers.ProjectMembershipSerializer
    permission_classes = [IsAuthenticated]
    pagination_class = pagination.DefaultPagination
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ["project", "role"]

    MANAGING_ROLES = {
        models.ProjectMembership.Role.OWNER,
        models.ProjectMembership.Role.MANAGER,
    }

    def get_queryset(self):
        return models.ProjectMembership.objects.filter(
            project__memberships__user=self.request.user
        ).select_related("user", "project").distinct()

    def _assert_can_manage(self, project):
        role = (
            models.ProjectMembership.objects.filter(
                project=project, user=self.request.user
            )
            .values_list("role", flat=True)
            .first()
        )
        if role not in self.MANAGING_ROLES:
            raise PermissionDenied("Only an owner or manager can change membership.")

    def perform_create(self, serializer):
        self._assert_can_manage(serializer.validated_data["project"])
        serializer.save()

    def perform_update(self, serializer):
        self._assert_can_manage(serializer.instance.project)
        serializer.save()

    def perform_destroy(self, instance):
        self._assert_can_manage(instance.project)
        instance.delete()


class SignatureAuditViewSet(
    mixins.CreateModelMixin,
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    GenericViewSet,
):
    """Append-only signature audit log.

    Create and read only — no update, no delete. Rows carry a digest and a
    certificate identity, never file content or a signature value; see
    `SignatureAudit`'s docstring.
    """

    serializer_class = serializers.SignatureAuditSerializer
    permission_classes = [IsAuthenticated]
    pagination_class = pagination.DefaultPagination
    filter_backends = [DjangoFilterBackend]
    filterset_fields = ["project", "container", "profile", "user"]

    def get_queryset(self):
        return (
            models.SignatureAudit.objects.filter(
                project__memberships__user=self.request.user
            )
            .select_related("user", "project")
            .distinct()
        )

    def perform_create(self, serializer):
        project = serializer.validated_data["project"]
        is_member = models.ProjectMembership.objects.filter(
            project=project, user=self.request.user
        ).exists()
        if not is_member:
            raise PermissionDenied("You are not a member of that project.")
        serializer.save(user=self.request.user)

    def create(self, request, *args, **kwargs):
        # Signing the same bytes twice with the same certificate in the same
        # project is a duplicate submission (a retried request, a double
        # click), not a second event. Return the existing row rather than
        # growing the log.
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        existing = models.SignatureAudit.objects.filter(
            project=serializer.validated_data["project"],
            user=request.user,
            digest_hex=serializer.validated_data["digest_hex"],
            cert_serial=serializer.validated_data["cert_serial"],
        ).first()
        if existing:
            return Response(
                self.get_serializer(existing).data, status=status.HTTP_200_OK
            )

        self.perform_create(serializer)
        return Response(serializer.data, status=status.HTTP_201_CREATED)
