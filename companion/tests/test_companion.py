"""
What the companion must and must not do.

These are guarantees, not features. A local service that drives a qualified
signing key is a remote-signing service for anyone who can reach it, so the
things that keep it safe are the things worth testing.
"""

import base64
import json
import threading
import unittest
import unittest.mock
import urllib.error
import urllib.request

from dice_companion.server import serve

TOKEN = "test-token"
ORIGIN = "http://localhost:3000"


class CompanionTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = serve("127.0.0.1", 0, TOKEN, [ORIGIN])
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def request(self, path, *, method="GET", token=None, origin=None, body=None):
        url = f"http://127.0.0.1:{self.port}{path}"
        headers = {}
        if token:
            headers["X-DiCE-Token"] = token
        if origin:
            headers["Origin"] = origin
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read() or b"{}"), dict(response.headers)
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"{}"), dict(error.headers)


class TokenTests(CompanionTestCase):
    def test_certificate_requires_the_token(self):
        status, payload, _ = self.request("/certificate")
        self.assertEqual(status, 403)
        self.assertEqual(payload["code"], "forbidden")

    def test_sign_requires_the_token(self):
        status, _, _ = self.request("/sign", method="POST", body={})
        self.assertEqual(status, 403)

    def test_a_wrong_token_is_refused(self):
        status, _, _ = self.request("/certificate", token="not-the-token")
        self.assertEqual(status, 403)

    def test_pairing_hands_the_token_to_an_allowed_origin(self):
        # The citizen never copies a token anywhere; the page asks for it.
        status, payload, _ = self.request("/pair", origin=ORIGIN)
        self.assertEqual(status, 200)
        self.assertEqual(payload["token"], TOKEN)

    def test_pairing_is_refused_to_any_other_origin(self):
        # The origin allow-list is the whole of the protection on /pair, so a
        # page from anywhere else must get nothing — not a token it cannot read,
        # but no token at all.
        status, payload, headers = self.request("/pair", origin="https://evil.example")
        self.assertEqual(status, 403)
        self.assertNotIn("token", payload)
        self.assertIsNone(headers.get("Access-Control-Allow-Origin"))

    def test_pairing_is_refused_when_there_is_no_origin_at_all(self):
        # curl, or anything else not driven by a browser.
        status, payload, _ = self.request("/pair")
        self.assertEqual(status, 403)
        self.assertNotIn("token", payload)

    def test_pairing_does_not_open_the_card_endpoints(self):
        # /pair is the only thing reachable without a token.
        for path, method in (("/certificate", "GET"), ("/sign", "POST")):
            status, _, _ = self.request(path, method=method, origin=ORIGIN)
            self.assertEqual(status, 403, path)

    def test_status_is_readable_without_pairing(self):
        # The setup page has to be able to say "the companion is running"
        # before anything is paired. It reveals only presence, never key material.
        status, payload, _ = self.request("/status")
        self.assertEqual(status, 200)
        self.assertFalse(payload["paired"])
        self.assertIn("cardPresent", payload)

    def test_status_reports_pairing_when_the_token_is_right(self):
        _, payload, _ = self.request("/status", token=TOKEN)
        self.assertTrue(payload["paired"])


class OriginTests(CompanionTestCase):
    def test_cors_headers_only_for_an_allowed_origin(self):
        _, _, headers = self.request("/status", origin=ORIGIN)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), ORIGIN)

    def test_no_cors_headers_for_anyone_else(self):
        # Without this a page on any origin could read the response even if it
        # somehow obtained the token.
        _, _, headers = self.request("/status", origin="https://evil.example.com")
        self.assertIsNone(headers.get("Access-Control-Allow-Origin"))

    def test_preflight_is_answered_for_an_allowed_origin(self):
        status, _, headers = self.request("/status", method="OPTIONS", origin=ORIGIN)
        self.assertEqual(status, 204)
        self.assertIn("X-DiCE-Token", headers.get("Access-Control-Allow-Headers", ""))


class BodyLimitTests(CompanionTestCase):
    def test_refuses_anything_larger_than_a_digest(self):
        # There is no endpoint here that takes a document, and this is what
        # keeps it that way.
        status, payload, _ = self.request(
            "/sign",
            method="POST",
            token=TOKEN,
            body={"data": base64.b64encode(b"x" * 9000).decode()},
        )
        self.assertEqual(status, 413)
        self.assertEqual(payload["code"], "too-large")

    def test_rejects_a_malformed_request(self):
        status, payload, _ = self.request("/sign", method="POST", token=TOKEN, body={})
        self.assertEqual(status, 400)
        self.assertEqual(payload["code"], "bad-request")


class RouteTests(CompanionTestCase):
    def test_unknown_routes_are_404(self):
        status, _, _ = self.request("/anything", token=TOKEN)
        self.assertEqual(status, 404)


class CardTests(CompanionTestCase):
    def test_empty_data_is_refused_before_touching_the_card(self):
        from dice_companion import card

        with self.assertRaises(card.CardError) as caught:
            card.sign_data(b"", "SHA-256", b"")
        self.assertEqual(caught.exception.code, "bad-request")

    def test_an_unknown_hash_is_refused(self):
        from dice_companion import card

        with self.assertRaises(card.CardError) as caught:
            card.sign_data(b"data", "MD5", b"")
        self.assertEqual(caught.exception.code, "unsupported")

    def test_digest_info_prefixes_are_the_rfc_8017_values(self):
        # A wrong prefix produces an RSA signature that verifies against
        # nothing, with no other symptom.
        from dice_companion.card import DIGEST_INFO_PREFIX

        self.assertEqual(
            DIGEST_INFO_PREFIX["SHA-256"].hex(),
            "3031300d060960864801650304020105000420",
        )
        self.assertEqual(
            DIGEST_INFO_PREFIX["SHA-512"].hex(),
            "3051300d060960864801650304020305000440",
        )

    def test_status_never_raises_without_a_card(self):
        from dice_companion import card

        state = card.status()
        self.assertIsInstance(state.card_present, bool)


if __name__ == "__main__":
    unittest.main()


class LoginBehaviourTests(unittest.TestCase):
    """
    How the PIN window is triggered.

    A Cartão de Cidadão reports `CKF_LOGIN_REQUIRED = false` and
    `CKF_PROTECTED_AUTHENTICATION_PATH = false`. Calling `C_Login` with a NULL
    PIN — the usual way to make a protected-path token prompt — fails with
    `CKR_GENERAL_ERROR`. The middleware prompts from inside `C_Sign` instead.

    These use a stub session because the real behaviour needs a card and a
    person; what they pin down is the *call sequence*, which is what was wrong.
    """

    def _stub(self, *, sign_results):
        import PyKCS11

        calls = []

        class StubSession:
            def getAttributeValue(self, handle, attrs):
                if PyKCS11.CKA_VALUE in attrs:
                    return [b"cert-bytes"]
                if PyKCS11.CKA_ID in attrs:
                    return [(0x46,)]
                if PyKCS11.CKA_KEY_TYPE in attrs:
                    return [PyKCS11.CKK_RSA]
                if PyKCS11.CKA_LABEL in attrs:
                    return ["CITIZEN SIGNATURE CERTIFICATE"]
                return [None]

            def findObjects(self, template):
                calls.append(("findObjects", template))
                return ["handle"]

            def sign(self, key, payload, mechanism):
                calls.append(("sign", bytes(payload)))
                result = sign_results.pop(0)
                if isinstance(result, Exception):
                    raise result
                return list(result)

            def login(self, pin=None):
                calls.append(("login", pin))

            def logout(self):
                calls.append(("logout", None))

            def closeSession(self):
                pass

        return StubSession(), calls

    def test_signs_without_logging_in(self):
        import PyKCS11
        from dice_companion import card

        session, calls = self._stub(sign_results=[b"\x01\x02"])
        with unittest.mock.patch.object(card, "_load", return_value=None), \
             unittest.mock.patch.object(card, "_open_session", return_value=session), \
             unittest.mock.patch.object(card, "_signature_certificate", return_value="h"):
            result = card.sign_data(b"to-be-signed", "SHA-256", b"cert-bytes")

        self.assertEqual(result["algorithm"], "RS256")
        # The bug: this used to call login() first, which fails on a real card.
        self.assertNotIn("login", [name for name, _ in calls])

    def test_the_rsa_payload_is_a_digestinfo(self):
        import PyKCS11
        from dice_companion import card

        session, calls = self._stub(sign_results=[b"\x01"])
        with unittest.mock.patch.object(card, "_load", return_value=None), \
             unittest.mock.patch.object(card, "_open_session", return_value=session), \
             unittest.mock.patch.object(card, "_signature_certificate", return_value="h"):
            card.sign_data(b"to-be-signed", "SHA-256", b"cert-bytes")

        # The first attempt is now the combined mechanism, which the card
        # hashes itself — so the payload is the data, not a DigestInfo.
        payload = next(value for name, value in calls if name == "sign")
        self.assertEqual(payload, b"to-be-signed")

        # The DigestInfo path still exists as the fallback, and still has to be
        # built correctly: CKM_RSA_PKCS pads but does not prepend the algorithm
        # identifier.
        session, calls = self._stub(
            sign_results=[PyKCS11.PyKCS11Error(PyKCS11.CKR_MECHANISM_INVALID), b"\x01"]
        )
        with unittest.mock.patch.object(card, "_load", return_value=None), \
             unittest.mock.patch.object(card, "_open_session", return_value=session), \
             unittest.mock.patch.object(card, "_signature_certificate", return_value="h"):
            card.sign_data(b"to-be-signed", "SHA-256", b"cert-bytes")

        fallback = [value for name, value in calls if name == "sign"][1]
        self.assertTrue(fallback.startswith(card.DIGEST_INFO_PREFIX["SHA-256"]))
        self.assertEqual(len(fallback), 19 + 32)

    def test_logs_in_only_when_the_card_asks(self):
        import PyKCS11
        from dice_companion import card

        not_logged_in = PyKCS11.PyKCS11Error(PyKCS11.CKR_USER_NOT_LOGGED_IN)
        session, calls = self._stub(sign_results=[not_logged_in, b"\x09"])
        with unittest.mock.patch.object(card, "_load", return_value=None), \
             unittest.mock.patch.object(card, "_open_session", return_value=session), \
             unittest.mock.patch.object(card, "_signature_certificate", return_value="h"):
            card.sign_data(b"to-be-signed", "SHA-256", b"cert-bytes")

        names = [name for name, _ in calls]
        self.assertEqual(names.count("sign"), 2)
        self.assertIn("login", names)
        # And no PIN was passed, on either path.
        self.assertIsNone(next(v for n, v in calls if n == "login"))
        self.assertIn("logout", names)

    def test_a_cancelled_pin_dialog_is_reported_as_cancelled(self):
        import PyKCS11
        from dice_companion import card

        cancelled = PyKCS11.PyKCS11Error(PyKCS11.CKR_FUNCTION_CANCELED)
        session, _ = self._stub(sign_results=[cancelled])
        with unittest.mock.patch.object(card, "_load", return_value=None), \
             unittest.mock.patch.object(card, "_open_session", return_value=session), \
             unittest.mock.patch.object(card, "_signature_certificate", return_value="h"):
            with self.assertRaises(card.CardError) as caught:
                card.sign_data(b"to-be-signed", "SHA-256", b"cert-bytes")

        self.assertEqual(caught.exception.code, "cancelled")


class MechanismFallbackTests(LoginBehaviourTests):
    """
    One PIN dialog per signature.

    The middleware raises its PIN window from inside `C_Sign`, **before** the
    card validates the mechanism. So an attempt ending in
    `CKR_MECHANISM_INVALID` has already cost the citizen a PIN entry, and every
    fallback asks for it a second time.

    A Cartão de Cidadão advertises `CKM_RSA_PKCS` with `CKF_SIGN` and then
    refuses it at `C_Sign` for the signature key, because the middleware hashes
    internally for a qualified signature. Trying it first therefore charged two
    dialogs for every signature — which is the bug these tests pin down.
    """

    def setUp(self):
        from dice_companion import card

        # The memory is process-global; a leftover entry would decide the
        # ordering these tests are about.
        card._MECHANISM_MEMORY.clear()

    def test_signs_a_cartao_de_cidadao_with_one_dialog(self):
        from dice_companion import card

        session, calls = self._stub(sign_results=[b"\x07\x08"])
        with unittest.mock.patch.object(card, "_load", return_value=None), \
             unittest.mock.patch.object(card, "_open_session", return_value=session), \
             unittest.mock.patch.object(card, "_signature_certificate", return_value="h"):
            result = card.sign_data(b"to-be-signed", "SHA-256", b"cert-bytes")

        payloads = [value for name, value in calls if name == "sign"]
        # Exactly one C_Sign, so exactly one PIN window.
        self.assertEqual(len(payloads), 1)
        # And it is the combined mechanism, which the card hashes itself.
        self.assertEqual(payloads[0], b"to-be-signed")
        self.assertEqual(result["algorithm"], "RS256")

    def test_falls_back_when_the_card_refuses_the_first_mechanism(self):
        import PyKCS11
        from dice_companion import card

        invalid = PyKCS11.PyKCS11Error(PyKCS11.CKR_MECHANISM_INVALID)
        session, calls = self._stub(sign_results=[invalid, b"\x07\x08"])
        with unittest.mock.patch.object(card, "_load", return_value=None), \
             unittest.mock.patch.object(card, "_open_session", return_value=session), \
             unittest.mock.patch.object(card, "_signature_certificate", return_value="h"):
            result = card.sign_data(b"to-be-signed", "SHA-256", b"cert-bytes")

        payloads = [value for name, value in calls if name == "sign"]
        self.assertEqual(len(payloads), 2)
        # Combined first, then the DigestInfo for a card that wants to be given
        # a digest rather than the data.
        self.assertEqual(payloads[0], b"to-be-signed")
        self.assertTrue(payloads[1].startswith(card.DIGEST_INFO_PREFIX["SHA-256"]))
        self.assertEqual(result["algorithm"], "RS256")

    def test_remembers_the_mechanism_so_the_second_signature_asks_once(self):
        import PyKCS11
        from dice_companion import card

        invalid = PyKCS11.PyKCS11Error(PyKCS11.CKR_MECHANISM_INVALID)

        # A card that refuses our default pays the extra dialog once...
        session, calls = self._stub(sign_results=[invalid, b"\x01"])
        with unittest.mock.patch.object(card, "_load", return_value=None), \
             unittest.mock.patch.object(card, "_open_session", return_value=session), \
             unittest.mock.patch.object(card, "_signature_certificate", return_value="h"):
            card.sign_data(b"to-be-signed", "SHA-256", b"cert-bytes")
        self.assertEqual(len([n for n, _ in calls if n == "sign"]), 2)

        # ...and never again, because the winner was recorded against the card.
        session, calls = self._stub(sign_results=[b"\x02"])
        with unittest.mock.patch.object(card, "_load", return_value=None), \
             unittest.mock.patch.object(card, "_open_session", return_value=session), \
             unittest.mock.patch.object(card, "_signature_certificate", return_value="h"):
            card.sign_data(b"to-be-signed", "SHA-256", b"cert-bytes")

        payloads = [value for name, value in calls if name == "sign"]
        self.assertEqual(len(payloads), 1)
        self.assertTrue(payloads[0].startswith(card.DIGEST_INFO_PREFIX["SHA-256"]))

    def test_does_not_retry_a_cancelled_pin(self):
        # Retrying would raise a second dialog at someone who just said no.
        import PyKCS11
        from dice_companion import card

        cancelled = PyKCS11.PyKCS11Error(PyKCS11.CKR_FUNCTION_CANCELED)
        session, calls = self._stub(sign_results=[cancelled, b"\x01"])
        with unittest.mock.patch.object(card, "_load", return_value=None), \
             unittest.mock.patch.object(card, "_open_session", return_value=session), \
             unittest.mock.patch.object(card, "_signature_certificate", return_value="h"):
            with self.assertRaises(card.CardError) as caught:
                card.sign_data(b"to-be-signed", "SHA-256", b"cert-bytes")

        self.assertEqual(caught.exception.code, "cancelled")
        self.assertEqual(len([n for n, _ in calls if n == "sign"]), 1)
