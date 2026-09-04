"""
Trust-service proxy endpoints.

Every one of these exists because the browser cannot make the request itself —
timestamp authorities, OCSP responders and trusted-list servers send no CORS
headers. See `trust/README.md`.

**No request body here is ever logged or stored.** A timestamp request carries a
hash of the user's document; forwarding it is unavoidable, keeping it is not.
"""

from __future__ import annotations

from django.http import HttpResponse
from drf_spectacular.utils import OpenApiParameter, extend_schema
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .services import (
    TrustServiceError,
    fetch_crl,
    fetch_ocsp,
    fetch_timestamp,
    fetch_tsl,
)

# The maximum size of anything this app accepts. A timestamp or OCSP request is
# a few hundred bytes; anything larger is a mistake or an attempt to use these
# endpoints as an upload, which they must never become.
MAX_REQUEST_BYTES = 16 * 1024


class TimestampView(APIView):
    """
    `POST /api/trust/timestamp` — forward an RFC 3161 request to a qualified TSA.

    The body is a DER `TimeStampReq`, which carries a **hash of the document and
    nothing else**. The document never leaves the browser.
    """

    permission_classes = [IsAuthenticated]
    parser_classes: list = []

    @extend_schema(
        request=bytes,
        responses={200: bytes},
        description="Forward an RFC 3161 timestamp request. Carries a hash only.",
    )
    def post(self, request):
        body = request.body
        if len(body) > MAX_REQUEST_BYTES:
            return Response(
                {"detail": "A timestamp request carries a hash, not a document."},
                status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            )

        try:
            result = fetch_timestamp(body)
        except TrustServiceError as error:
            # 503, not 500: the service is unavailable or unconfigured, which is
            # a state the UI should explain rather than an application fault.
            return Response(
                {"detail": str(error)}, status=status.HTTP_503_SERVICE_UNAVAILABLE
            )

        return HttpResponse(result.content, content_type=result.content_type)


class OcspView(APIView):
    """`POST /api/trust/ocsp?url=…` — forward an OCSP request."""

    permission_classes = [AllowAny]
    parser_classes: list = []

    @extend_schema(
        parameters=[OpenApiParameter("url", str, required=True)],
        request=bytes,
        responses={200: bytes},
    )
    def post(self, request):
        url = request.query_params.get("url", "")
        body = request.body

        if len(body) > MAX_REQUEST_BYTES:
            return Response(
                {"detail": "An OCSP request carries a certificate serial, not a document."},
                status=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            )

        try:
            result = fetch_ocsp(url, body)
        except TrustServiceError as error:
            return Response(
                {"detail": str(error)}, status=status.HTTP_502_BAD_GATEWAY
            )

        return HttpResponse(
            result.content, content_type=result.content_type, status=result.status
        )


class CrlView(APIView):
    """`GET /api/trust/crl?url=…` — a cached CRL."""

    permission_classes = [AllowAny]

    @extend_schema(parameters=[OpenApiParameter("url", str, required=True)])
    def get(self, request):
        try:
            result = fetch_crl(request.query_params.get("url", ""))
        except TrustServiceError as error:
            return Response({"detail": str(error)}, status=status.HTTP_502_BAD_GATEWAY)

        return HttpResponse(result.content, content_type=result.content_type)


class TslView(APIView):
    """`GET /api/trust/tsl` — the cached EU List of Trusted Lists."""

    permission_classes = [AllowAny]

    @extend_schema(responses={200: bytes})
    def get(self, request):
        try:
            result = fetch_tsl()
        except TrustServiceError as error:
            return Response({"detail": str(error)}, status=status.HTTP_502_BAD_GATEWAY)

        return HttpResponse(result.content, content_type=result.content_type)
