from django.urls import path, include
from django.views.generic import TemplateView
from rest_framework.routers import DefaultRouter

from . import views
from .auth import MyTokenView

router = DefaultRouter()
router.register('admin/users', views.AdminUserViewSet, basename='admin-user')
router.register('admin/groups', views.AdminGroupViewSet, basename='admin-group')
router.register('admin/permissions', views.AdminPermissionViewSet,
                basename='admin-permission')

# URLConf
urlpatterns = [
    path('', TemplateView.as_view(template_name='core/index.html')),
    path("auth/jwt/create", MyTokenView.as_view(), name="jwt-create"),
    # 'auth/users/me/' is intentionally handled by djoser (included in the
    # project urls), which supports GET/PATCH/DELETE. A custom GET-only override
    # here would shadow djoser's endpoint and break profile updates.
    path('', include(router.urls)),
]
