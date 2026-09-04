"""
What the trust proxy must and must not do.

These are guarantees, not features: an open relay or a proxy that quietly
timestamps against a non-qualified TSA would each be worse than having no
proxy at all.
"""

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.urls import reverse
from rest_framework.test import APIClient

from .services import TrustServiceError, fetch_crl, fetch_ocsp

# The project caches in Redis, which is not running for a unit-test pass. The
# caching behaviour itself is not what these tests are about.
LOCAL_CACHE = {
    "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}
}


@override_settings(CACHES=LOCAL_CACHE)
class TimestampTests(TestCase):
    def setUp(self):
        # The API authenticates with JWT, not sessions, so `force_login` would
        # leave every request anonymous and every assertion here would be
        # testing the permission class instead of the thing it names.
        self.user = get_user_model().objects.create_user(
            email="engenheiro@example.pt", password="not-a-real-password"
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    @override_settings(TRUST_TSA_URL="")
    def test_disabled_until_a_qualified_tsa_is_chosen(self):
        # Better to fail loudly than to sign against a free non-qualified TSA
        # and produce timestamps that look qualified. See open question Q5.
        response = self.client.post(
            reverse("trust-timestamp"),
            data=b"\x30\x00",
            content_type="application/timestamp-query",
        )

        self.assertEqual(response.status_code, 503)
        self.assertIn("qualified TSA", response.json()["detail"])

    @override_settings(TRUST_TSA_URL="https://tsa.example.pt")
    def test_refuses_anything_larger_than_a_hash(self):
        # These endpoints must never become an upload path.
        response = self.client.post(
            reverse("trust-timestamp"),
            data=b"x" * (16 * 1024 + 1),
            content_type="application/timestamp-query",
        )

        self.assertEqual(response.status_code, 413)

    def test_requires_authentication(self):
        self.client.force_authenticate(user=None)
        response = self.client.post(
            reverse("trust-timestamp"),
            data=b"\x30\x00",
            content_type="application/timestamp-query",
        )

        self.assertIn(response.status_code, (401, 403))


@override_settings(TRUST_ALLOWED_HOSTS=["pki.cartaodecidadao.pt"], CACHES=LOCAL_CACHE)
class AllowListTests(TestCase):
    """
    Without an allow-list the proxy is an open relay: anyone could point it at
    an internal address and read the response through our server.
    """

    def test_ocsp_refuses_a_host_that_is_not_allowed(self):
        with self.assertRaises(TrustServiceError) as caught:
            fetch_ocsp("https://evil.example.com/ocsp", b"")

        self.assertIn("not an allowed", str(caught.exception))

    def test_crl_refuses_a_host_that_is_not_allowed(self):
        with self.assertRaises(TrustServiceError):
            fetch_crl("http://169.254.169.254/latest/meta-data/")

    def test_refuses_a_non_http_scheme(self):
        with self.assertRaises(TrustServiceError):
            fetch_crl("file:///etc/passwd")

    def test_allows_a_subdomain_of_an_allowed_host(self):
        # Should get past the allow-list and fail on the network instead.
        with self.assertRaises(TrustServiceError) as caught:
            fetch_crl("https://sub.pki.cartaodecidadao.pt/crl")

        self.assertNotIn("not an allowed", str(caught.exception))

    def test_ocsp_endpoint_rejects_an_oversized_body(self):
        response = self.client.post(
            reverse("trust-ocsp") + "?url=https://pki.cartaodecidadao.pt/ocsp",
            data=b"x" * (16 * 1024 + 1),
            content_type="application/ocsp-request",
        )

        self.assertEqual(response.status_code, 413)


class NoPersistenceTests(TestCase):
    def test_the_app_stores_nothing(self):
        # The proxy has no models by design: a timestamp request carries a hash
        # of the user's document, and the only safe place for it is nowhere.
        from django.apps import apps

        self.assertEqual(list(apps.get_app_config("trust").get_models()), [])
