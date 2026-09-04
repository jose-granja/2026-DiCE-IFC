"""
Fetching trust-service data on the browser's behalf.

Kept out of the views so the caching policy and the "never persist a digest"
rule live in one place, and so the views stay about HTTP.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import requests
from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)

# Deliberately short. A proxy that hangs is worse than one that fails: the
# browser is showing a spinner over a signature the user is waiting on.
TIMEOUT_SECONDS = 15

# The EU List of Trusted Lists. The Portuguese list is reachable through it.
DEFAULT_LOTL_URL = "https://ec.europa.eu/tools/lotl/eu-lotl.xml"

TSL_CACHE_KEY = "trust:tsl"
TSL_CACHE_SECONDS = 24 * 60 * 60

CRL_CACHE_PREFIX = "trust:crl:"
CRL_CACHE_SECONDS = 6 * 60 * 60


@dataclass
class ProxyResponse:
    content: bytes
    content_type: str
    status: int = 200


class TrustServiceError(Exception):
    """A trust service could not be reached, or refused."""


def fetch_timestamp(request_der: bytes) -> ProxyResponse:
    """
    Forward an RFC 3161 timestamp request.

    `request_der` carries a hash of the user's document and nothing else. It is
    forwarded and discarded — never logged, never stored. That is the whole
    reason this function exists rather than the view doing it inline.
    """
    url = getattr(settings, "TRUST_TSA_URL", "") or ""
    if not url:
        raise TrustServiceError(
            "No timestamp authority is configured. XAdES-T needs a qualified TSA; "
            "set TRUST_TSA_URL once one has been chosen (see open question Q5). "
            "Signatures are XAdES-B until then."
        )

    try:
        response = requests.post(
            url,
            data=request_der,
            headers={
                "Content-Type": "application/timestamp-query",
                "Accept": "application/timestamp-reply",
            },
            timeout=TIMEOUT_SECONDS,
        )
    except requests.RequestException as error:
        # The message, never the request body.
        raise TrustServiceError(f"The timestamp authority could not be reached: {error}") from error

    if response.status_code != 200:
        raise TrustServiceError(
            f"The timestamp authority returned {response.status_code}."
        )

    return ProxyResponse(
        content=response.content,
        content_type=response.headers.get("Content-Type", "application/timestamp-reply"),
    )


def fetch_ocsp(url: str, request_der: bytes) -> ProxyResponse:
    """Forward an OCSP request. Carries a certificate serial, not a document."""
    _require_allowed(url)

    try:
        response = requests.post(
            url,
            data=request_der,
            headers={
                "Content-Type": "application/ocsp-request",
                "Accept": "application/ocsp-response",
            },
            timeout=TIMEOUT_SECONDS,
        )
    except requests.RequestException as error:
        raise TrustServiceError(f"The OCSP responder could not be reached: {error}") from error

    return ProxyResponse(
        content=response.content,
        content_type=response.headers.get("Content-Type", "application/ocsp-response"),
        status=response.status_code,
    )


def fetch_crl(url: str) -> ProxyResponse:
    """A CRL, cached: they are large and change slowly."""
    _require_allowed(url)

    key = f"{CRL_CACHE_PREFIX}{url}"
    cached = cache.get(key)
    if cached is not None:
        return ProxyResponse(content=cached, content_type="application/pkix-crl")

    try:
        response = requests.get(url, timeout=TIMEOUT_SECONDS)
        response.raise_for_status()
    except requests.RequestException as error:
        raise TrustServiceError(f"The CRL could not be fetched: {error}") from error

    cache.set(key, response.content, CRL_CACHE_SECONDS)
    return ProxyResponse(content=response.content, content_type="application/pkix-crl")


def fetch_tsl() -> ProxyResponse:
    """The EU List of Trusted Lists, cached for a day."""
    cached = cache.get(TSL_CACHE_KEY)
    if cached is not None:
        return ProxyResponse(content=cached, content_type="application/xml")

    url = getattr(settings, "TRUST_LOTL_URL", DEFAULT_LOTL_URL)
    try:
        response = requests.get(url, timeout=TIMEOUT_SECONDS)
        response.raise_for_status()
    except requests.RequestException as error:
        raise TrustServiceError(f"The trusted list could not be fetched: {error}") from error

    cache.set(TSL_CACHE_KEY, response.content, TSL_CACHE_SECONDS)
    return ProxyResponse(content=response.content, content_type="application/xml")


def _require_allowed(url: str) -> None:
    """
    Only fetch from hosts we have named.

    Without this the proxy is an open relay: anyone could point it at an
    internal address and read the response through our server. The allow-list is
    the CC chain's own endpoints.
    """
    allowed = getattr(settings, "TRUST_ALLOWED_HOSTS", [])
    if not url.startswith("http://") and not url.startswith("https://"):
        raise TrustServiceError("Only http and https URLs may be proxied.")

    host = url.split("/")[2].split(":")[0].lower()
    if not any(host == entry or host.endswith(f".{entry}") for entry in allowed):
        raise TrustServiceError(
            f"{host} is not an allowed trust-service host. "
            f"Add it to TRUST_ALLOWED_HOSTS if it belongs to the certificate chain."
        )
