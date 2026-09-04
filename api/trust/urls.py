from django.urls import path

from .views import CrlView, OcspView, TimestampView, TslView

urlpatterns = [
    path("trust/timestamp", TimestampView.as_view(), name="trust-timestamp"),
    path("trust/ocsp", OcspView.as_view(), name="trust-ocsp"),
    path("trust/crl", CrlView.as_view(), name="trust-crl"),
    path("trust/tsl", TslView.as_view(), name="trust-tsl"),
]
