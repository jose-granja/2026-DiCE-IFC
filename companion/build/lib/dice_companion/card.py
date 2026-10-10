"""
The Cartão de Cidadão, over PKCS#11.

Everything that touches the card is here. The rules it enforces come from the
project brief and ADR 004, and each one has a reason worth keeping:

- **The CITIZEN SIGNATURE key only.** The card carries two key pairs. The
  authentication key is for TLS client authentication and may not be used to
  sign documents; using it would produce a signature that is cryptographically
  fine and legally worthless. If the signature certificate cannot be found, this
  fails rather than falling back.

- **Never a PIN parameter.** `pteid-pkcs11` raises its own PIN window; there is
  nowhere in this file for a PIN to be passed, cached or logged.

  How that window is triggered was got wrong first time, so it is worth stating
  what the card actually reports. A Cartão de Cidadão advertises
  **`CKF_LOGIN_REQUIRED = false`** and **`CKF_PROTECTED_AUTHENTICATION_PATH =
  false`**. Calling `C_Login` with a NULL PIN — the usual way to ask a
  protected-path token to prompt — therefore fails with `CKR_GENERAL_ERROR`,
  preceded by a wall of ASN.1 parse errors from the middleware's own EAC code.
  The middleware prompts from inside **`C_Sign`**, so the right thing to do is
  simply not to log in. `C_Login` is attempted only if signing comes back with
  `CKR_USER_NOT_LOGGED_IN`, which covers middleware versions that want it.

- **Never assume RSA.** A CC v1 has an RSA key, a CC v2 (June 2024 onwards) an
  ECDSA one. The mechanism is chosen from the key type the card reports.
"""

from __future__ import annotations

import hashlib
import os
import platform
from dataclasses import dataclass
from typing import Optional

import PyKCS11

# Where the Autenticação.gov middleware installs its PKCS#11 module.
MODULE_PATHS = {
    "Windows": [r"C:\Windows\System32\pteidpkcs11.dll"],
    "Darwin": [
        "/usr/local/lib/libpteidpkcs11.dylib",
        "/Library/Frameworks/eidlib.framework/Versions/Current/libpteidpkcs11.dylib",
    ],
    "Linux": [
        "/usr/local/lib/libpteidpkcs11.so",
        "/usr/lib/libpteidpkcs11.so",
        "/usr/lib/x86_64-linux-gnu/libpteidpkcs11.so",
    ],
}

# The label pteid gives the signing certificate and its key. The authentication
# pair is labelled "CITIZEN AUTHENTICATION …" and is deliberately not matched.
SIGNATURE_LABEL = "CITIZEN SIGNATURE CERTIFICATE"
SIGNATURE_KEY_LABEL = "CITIZEN SIGNATURE KEY"

# DigestInfo prefixes for RSASSA-PKCS1-v1_5 (RFC 8017 §9.2). `CKM_RSA_PKCS`
# signs the value it is given with PKCS#1 v1.5 padding but does **not** add the
# algorithm identifier, so it has to be prepended here. Getting this wrong
# produces a signature that verifies against nothing.
DIGEST_INFO_PREFIX = {
    "SHA-256": bytes.fromhex("3031300d060960864801650304020105000420"),
    "SHA-384": bytes.fromhex("3041300d060960864801650304020205000430"),
    "SHA-512": bytes.fromhex("3051300d060960864801650304020305000440"),
}

DIGEST_LENGTH = {"SHA-256": 32, "SHA-384": 48, "SHA-512": 64}

# Mechanisms that hash on the card, by hash name. Used as a fallback: a Cartão
# de Cidadão advertises CKM_RSA_PKCS with CKF_SIGN and then rejects it at
# C_Sign time for the *signature* key with CKR_MECHANISM_INVALID — the
# middleware insists on hashing internally for a qualified signature. The raw
# mechanism is still tried first, because it is the one that needs only a
# digest.
COMBINED_RSA = {
    "SHA-256": PyKCS11.CKM_SHA256_RSA_PKCS,
    "SHA-384": PyKCS11.CKM_SHA384_RSA_PKCS,
    "SHA-512": PyKCS11.CKM_SHA512_RSA_PKCS,
}
COMBINED_ECDSA = {
    "SHA-256": getattr(PyKCS11, "CKM_ECDSA_SHA256", None),
    "SHA-384": getattr(PyKCS11, "CKM_ECDSA_SHA384", None),
    "SHA-512": getattr(PyKCS11, "CKM_ECDSA_SHA512", None),
}


class CardError(Exception):
    """Something about the card, the reader or the middleware is not right."""

    def __init__(self, message: str, code: str = "unknown"):
        super().__init__(message)
        self.code = code


@dataclass
class CardStatus:
    module_path: Optional[str]
    reader: Optional[str]
    card_present: bool

    @property
    def ready(self) -> bool:
        return bool(self.module_path) and self.card_present


def find_module() -> Optional[str]:
    """The middleware's PKCS#11 module, or None if it is not installed."""
    override = os.environ.get("DICE_PKCS11_MODULE")
    if override:
        return override if os.path.exists(override) else None

    for path in MODULE_PATHS.get(platform.system(), []):
        if os.path.exists(path):
            return path
    return None


def _load() -> PyKCS11.PyKCS11Lib:
    module = find_module()
    if not module:
        raise CardError(
            "The Autenticação.gov middleware was not found. Install it from "
            "autenticacao.gov.pt — it provides the PKCS#11 module the card needs.",
            code="no-middleware",
        )

    library = PyKCS11.PyKCS11Lib()
    try:
        library.load(module)
    except PyKCS11.PyKCS11Error as error:
        raise CardError(
            f"The PKCS#11 module at {module} could not be loaded: {error}",
            code="no-middleware",
        ) from error
    return library


def status() -> CardStatus:
    """
    Never raises.

    A missing reader or card is the ordinary state of a machine, not an
    exception — the setup page exists to report exactly this.
    """
    module = find_module()
    if not module:
        return CardStatus(None, None, False)

    try:
        library = _load()
        slots = library.getSlotList(tokenPresent=False)
        if not slots:
            return CardStatus(module, None, False)

        for slot in slots:
            info = library.getSlotInfo(slot)
            reader = info.slotDescription.strip()
            try:
                library.getTokenInfo(slot)
                return CardStatus(module, reader, True)
            except PyKCS11.PyKCS11Error:
                continue

        first = library.getSlotInfo(slots[0]).slotDescription.strip()
        return CardStatus(module, first, False)
    except Exception:
        return CardStatus(module, None, False)


def _open_session(library: PyKCS11.PyKCS11Lib) -> PyKCS11.Session:
    slots = library.getSlotList(tokenPresent=True)
    if not slots:
        raise CardError(
            "No card was found. Insert the Cartão de Cidadão into the reader.",
            code="no-card",
        )
    return library.openSession(slots[0], PyKCS11.CKF_SERIAL_SESSION)


def _signature_certificate(session: PyKCS11.Session):
    """
    The CITIZEN SIGNATURE certificate.

    Matched by label rather than by position: the order of objects on the card
    is not guaranteed, and picking the wrong one would silently sign with the
    authentication key.
    """
    certificates = session.findObjects(
        [(PyKCS11.CKA_CLASS, PyKCS11.CKO_CERTIFICATE)]
    )

    for handle in certificates:
        (label,) = session.getAttributeValue(handle, [PyKCS11.CKA_LABEL])
        if label and SIGNATURE_LABEL.lower() in str(label).lower():
            return handle

    raise CardError(
        "The signature certificate was not found on this card. Only the "
        "CITIZEN SIGNATURE key may be used to sign documents, and this "
        "application will not fall back to the authentication key.",
        code="no-signature-key",
    )


def read_certificate() -> dict:
    """The signing certificate and, when the card carries them, its issuers."""
    library = _load()
    session = _open_session(library)
    try:
        handle = _signature_certificate(session)
        (value,) = session.getAttributeValue(handle, [PyKCS11.CKA_VALUE])
        der = bytes(value)

        chain = []
        for other in session.findObjects([(PyKCS11.CKA_CLASS, PyKCS11.CKO_CERTIFICATE)]):
            if other == handle:
                continue
            (label,) = session.getAttributeValue(other, [PyKCS11.CKA_LABEL])
            text = str(label or "")
            # The CA certificates on the card; the authentication certificate is
            # not part of this chain and must not be offered as if it were.
            if "AUTHENTICATION" in text.upper():
                continue
            (raw,) = session.getAttributeValue(other, [PyKCS11.CKA_VALUE])
            chain.append(bytes(raw))

        return {"certificate": der, "chain": chain}
    finally:
        session.closeSession()


def sign_data(data: bytes, hash_name: str, expect_certificate: bytes) -> dict:
    """
    Sign `data` with the signature key.

    `data` is the caller's *to-be-signed* bytes — for XAdES, the canonicalised
    `SignedInfo`, which is a few hundred bytes of digests, URIs and algorithm
    names. It is never a document: the model is hashed in the browser and only
    its digest appears inside `SignedInfo`.

    ## One PIN prompt, not two

    The order below matters more than it looks, and it was wrong at first.

    The middleware raises its PIN window **from inside `C_Sign`, before the
    card validates the mechanism**. So an attempt that ends in
    `CKR_MECHANISM_INVALID` has *already* cost the citizen a PIN entry, and
    falling back to a second mechanism asks them for it again. Trying the
    "nicer" mechanism first and falling back was therefore a design that
    charged every signature two PIN dialogs.

    Two things fix it:

    1. **The mechanism the Cartão de Cidadão actually accepts is tried first.**
       For an RSA card that is the combined `CKM_SHA256_RSA_PKCS` over the data:
       the card advertises raw `CKM_RSA_PKCS` with `CKF_SIGN` and then refuses
       it for the signature key, because the middleware insists on hashing
       internally for qualified signatures. Both mechanisms produce the same
       signature value, so preferring the one that works costs nothing.
    2. **What worked is remembered** (see `_remember`/`_recall`), keyed by the
       card's serial and the key type. A card whose first choice is refused
       pays the second dialog once, ever, instead of on every signature.

    A fallback still exists, because a card that refuses the first mechanism
    must not be unable to sign at all — but it is now the rare path rather than
    the normal one.

    The middleware raises its own PIN window during `C_Sign`; this call blocks
    until the citizen answers it. No timeout on purpose — a person reading a PIN
    prompt should not have the operation cancelled underneath them.
    """
    if hash_name not in DIGEST_LENGTH:
        raise CardError(f"Unsupported hash algorithm: {hash_name}", code="unsupported")
    if not data:
        raise CardError("There is nothing to sign.", code="bad-request")

    digest = hashlib.new(hash_name.replace("-", "").lower(), data).digest()

    library = _load()
    session = _open_session(library)
    try:
        handle = _signature_certificate(session)
        (value,) = session.getAttributeValue(handle, [PyKCS11.CKA_VALUE])

        # The card must still be the one the caller prepared against. Without
        # this a card swapped mid-operation signs a SignedInfo that names
        # someone else's certificate — valid-looking and unverifiable.
        if bytes(value) != expect_certificate:
            raise CardError(
                "The card changed between reading the certificate and signing.",
                code="card-changed",
            )

        (key_id,) = session.getAttributeValue(handle, [PyKCS11.CKA_ID])
        keys = session.findObjects(
            [(PyKCS11.CKA_CLASS, PyKCS11.CKO_PRIVATE_KEY), (PyKCS11.CKA_ID, key_id)]
        )
        if not keys:
            raise CardError(
                "The signature key was not found on this card.", code="no-signature-key"
            )
        key = keys[0]

        (key_type,) = session.getAttributeValue(key, [PyKCS11.CKA_KEY_TYPE])

        bits = hash_name.split("-")[1]
        if key_type == PyKCS11.CKK_ECDSA:
            # CKM_ECDSA signs the digest directly and returns P1363 r‖s, which
            # is exactly what XMLDSig wants — do not DER-encode it.
            attempts = [(PyKCS11.CKM_ECDSA, digest)]
            combined = COMBINED_ECDSA.get(hash_name)
            if combined is not None:
                attempts.append((combined, data))
            algorithm = f"ES{bits}"
        else:
            # Combined first: this is the one a Cartão de Cidadão accepts for
            # the signature key. Raw CKM_RSA_PKCS is kept as a fallback for
            # other cards, with the DigestInfo built here because that mechanism
            # pads but does not prepend the algorithm identifier.
            attempts = [
                (COMBINED_RSA[hash_name], data),
                (PyKCS11.CKM_RSA_PKCS, DIGEST_INFO_PREFIX[hash_name] + digest),
            ]
            algorithm = f"RS{bits}"

        # A mechanism this card is known to accept goes to the front, so the
        # rare card that refuses our default pays a second dialog once rather
        # than on every signature.
        attempts = _preferred_first(attempts, _recall(_card_key(session, key_type)))

        signature, used = _sign_with_fallback(session, key, attempts)
        _remember(_card_key(session, key_type), used)

        return {
            "signature": signature,
            "algorithm": algorithm,
            "certificate": bytes(value),
        }
    finally:
        session.closeSession()


def _sign_with_fallback(session, key, attempts) -> tuple[bytes, int]:
    """
    Try each mechanism until one is accepted; return the signature and the
    mechanism that produced it.

    `CKR_MECHANISM_INVALID` is the only error worth retrying on: it means the
    card will not do this *kind* of signature, not that anything is wrong with
    the request. A cancelled PIN, a blocked PIN or a removed card are all final.

    Retrying is not free. The middleware prompts for the PIN **before** the card
    rejects the mechanism, so every fallback here costs the citizen a second
    dialog. That is why the caller orders the attempts so the working one comes
    first and records the winner — see `sign_data`. Reaching the second entry of
    this list should be a once-per-card event, not routine.

    `CKR_USER_NOT_LOGGED_IN` is handled here too, for middleware versions that
    want an explicit `C_Login` — still with no PIN from us.
    """
    last: PyKCS11.PyKCS11Error | None = None
    logged_in = False

    try:
        for mechanism_type, payload in attempts:
            mechanism = PyKCS11.Mechanism(mechanism_type, None)
            try:
                return bytes(session.sign(key, payload, mechanism)), mechanism_type
            except PyKCS11.PyKCS11Error as error:
                last = error

                if _is_not_logged_in(error) and not logged_in:
                    try:
                        session.login(None)
                        logged_in = True
                    except PyKCS11.PyKCS11Error as login_error:
                        raise _login_error(login_error) from login_error
                    try:
                        return (
                            bytes(session.sign(key, payload, mechanism)),
                            mechanism_type,
                        )
                    except PyKCS11.PyKCS11Error as retry_error:
                        last = retry_error
                        if not _is_mechanism_invalid(retry_error):
                            raise _sign_error(retry_error) from retry_error
                        continue

                if not _is_mechanism_invalid(error):
                    raise _sign_error(error) from error
    finally:
        if logged_in:
            try:
                session.logout()
            except PyKCS11.PyKCS11Error:
                pass

    raise _sign_error(last) if last else CardError("The card could not sign.")


# Which mechanism each card accepted last time.
#
# In-process only, deliberately. It is a latency optimisation, not a security
# decision, and writing a file to the citizen's home directory to hold it would
# be a worse trade: a companion restart costing one extra PIN dialog on an
# unusual card is cheaper than a state file nobody knows exists. The common
# case — a Cartão de Cidadão — never reaches the fallback at all, because the
# default order is already right for it.
_MECHANISM_MEMORY: dict[str, int] = {}


def _card_key(session, key_type: int) -> str:
    """
    Identify the card, so one card's answer is not applied to another.

    Falls back to the key type alone when the serial cannot be read: a wrong
    guess here costs one extra dialog, never a wrong signature.
    """
    try:
        info = session.getSessionInfo()
        token = session.pykcs11.getTokenInfo(info.slotID)
        serial = str(getattr(token, "serialNumber", "") or "").strip()
    except Exception:  # noqa: BLE001 - any failure here is non-fatal by design
        serial = ""
    return f"{serial}:{key_type}"


def _recall(card_key: str) -> Optional[int]:
    return _MECHANISM_MEMORY.get(card_key)


def _remember(card_key: str, mechanism_type: int) -> None:
    _MECHANISM_MEMORY[card_key] = mechanism_type


def _preferred_first(attempts: list, preferred: Optional[int]) -> list:
    """Move a known-good mechanism to the front, keeping the rest as fallbacks."""
    if preferred is None:
        return attempts
    known = [entry for entry in attempts if entry[0] == preferred]
    if not known:
        return attempts
    return known + [entry for entry in attempts if entry[0] != preferred]


def _is_mechanism_invalid(error: PyKCS11.PyKCS11Error) -> bool:
    return "MECHANISM_INVALID" in str(error).upper()


def _is_not_logged_in(error: PyKCS11.PyKCS11Error) -> bool:
    return "USER_NOT_LOGGED_IN" in str(error).upper()


def _login_error(error: PyKCS11.PyKCS11Error) -> CardError:
    text = str(error).upper()
    if "CANCEL" in text:
        return CardError("The PIN entry was cancelled.", code="cancelled")
    if "LOCKED" in text or "BLOCKED" in text:
        return CardError(
            "The signature PIN is blocked. Unblock it with the Autenticação.gov "
            "application using the PUK.",
            code="pin-blocked",
        )
    if "INCORRECT" in text or "PIN_INVALID" in text or "PIN_LEN" in text:
        return CardError("The PIN was not accepted by the card.", code="pin-incorrect")
    return CardError(f"The card refused the operation: {error}", code="unknown")


def _sign_error(error: PyKCS11.PyKCS11Error) -> CardError:
    text = str(error).upper()
    if "CANCEL" in text:
        return CardError("Signing was cancelled.", code="cancelled")
    if "REMOVED" in text:
        return CardError("The card was removed during signing.", code="card-changed")
    return CardError(f"The card could not sign: {error}", code="unknown")
