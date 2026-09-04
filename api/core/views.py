from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.filters import SearchFilter
from rest_framework.permissions import IsAdminUser, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .pagination import DefaultPagination

from .serializers import (
    AdminUserSerializer,
    GroupSerializer,
    PermissionSerializer,
)

User = get_user_model()


class MeView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        user = request.user
        return Response({
            "id": user.id,
            "username": user.get_username(),
            "email": user.email,
            "first_name": user.first_name,
            "last_name": user.last_name,
            "is_superuser": user.is_superuser,
            "is_staff": user.is_staff,
            "permissions": sorted(user.get_all_permissions()),
        })


# ── Admin (staff-only) ───────────────────────────────────────────────────────


class AdminUserViewSet(viewsets.ModelViewSet):
    """
    Manage users (staff-only). Supports listing, retrieving, partial updates
    (is_active, is_staff, groups/role, first_name, last_name, email) and
    deletion. Also exposes a user's applications and notifications.
    """
    queryset = User.objects.all().order_by('email')
    serializer_class = AdminUserSerializer
    permission_classes = [IsAdminUser]
    http_method_names = ['get', 'patch', 'delete', 'head', 'options']
    pagination_class = DefaultPagination
    filter_backends = [DjangoFilterBackend, SearchFilter]
    # ?is_active=true/false and ?groups=<group id> (role)
    filterset_fields = ['is_active', 'groups']
    search_fields = ['email', 'first_name', 'last_name']

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()

        # Safety guards: never let an admin delete themselves or a superuser
        # through this endpoint.
        if instance == request.user:
            return Response(
                {'detail': 'You cannot delete your own account here.'},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if instance.is_superuser:
            return Response(
                {'detail': 'Superuser accounts cannot be deleted here.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Require the caller to confirm the user's email before deleting.
        confirm_email = (request.data or {}).get('confirm_email')
        if not confirm_email or confirm_email.strip().lower() != instance.email.lower():
            return Response(
                {'detail': "The confirmation email does not match this user's email."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return super().destroy(request, *args, **kwargs)



class AdminGroupViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Group.objects.all().order_by('name')
    serializer_class = GroupSerializer
    permission_classes = [IsAdminUser]


class AdminPermissionViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = (
        Permission.objects.all()
        .select_related('content_type')
        .order_by('content_type__app_label', 'content_type__model', 'codename')
    )
    serializer_class = PermissionSerializer
    permission_classes = [IsAdminUser]
