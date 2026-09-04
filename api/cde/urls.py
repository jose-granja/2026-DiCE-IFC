from django.urls import include, path
from rest_framework.routers import DefaultRouter

from . import views

router = DefaultRouter()
router.register('projects', views.ProjectViewSet, basename='project')
router.register('project-memberships', views.ProjectMembershipViewSet,
                basename='project-membership')
router.register('signature-audits', views.SignatureAuditViewSet,
                basename='signature-audit')

# URLConf
urlpatterns = [
    path('', include(router.urls)),
]
