/**
 * The real Cartão de Cidadão, through the Web eID browser extension.
 *
 * ## Status — read this before trusting it
 *
 * **This talks to an extension that does not exist yet for Portugal.** ADR 004
 * established that Web eID cannot be pointed at `pteidpkcs11` by configuration:
 * the card type, the module path and the ATR tables are all compiled in, and
 * Portugal is not among them. The decision was to maintain a small fork (four
 * mechanical edits) and to upstream it. **That fork has not been built.**
 *
 * So this provider is written against Web eID's documented `postMessage`
 * protocol and is **unverified against a real extension**. On any machine today
 * `getReadiness()` reports the extension as missing, which is the truth, and
 * `/sign/setup` explains what is missing and why. Nothing here silently
 * pretends to work: every path either succeeds against a real extension or
 * fails with a `SigningError` that names what was absent.
 *
 * `@web-eid/web-eid-library` would normally wrap this protocol, but it is not
 * published to the public npm registry, so the protocol is implemented directly
 * rather than adding a dependency that cannot be installed.
 *
 * ## What it does not do
 *
 * It never asks for a PIN. The pteid PKCS#11 module raises its own dialog, and
 * Web eID's `providesExternalPinDialog` flag — already a first-class, shipped
 * path for the Belgian, Czech and Luxembourg cards — is what makes the fork
 * cheap. See ADR 004.
 */

import {
  SigningError,
  type ReadinessCheck,
  type ReadinessReport,
  type SignRequest,
  type SignResult,
  type SignatureAlgorithm,
  type SigningCertificate,
  type SigningProvider,
} from "../provider";
import { base64, fromBase64 } from "../canonical";
import { readCertificate } from "../der";

/** Web eID's page ↔ extension protocol. */
const ACTION = {
  status: "web-eid:status",
  statusAck: "web-eid:status-ack",
  statusSuccess: "web-eid:status-success",
  statusFailure: "web-eid:status-failure",
  getCertificate: "web-eid:get-signing-certificate",
  getCertificateSuccess: "web-eid:get-signing-certificate-success",
  getCertificateFailure: "web-eid:get-signing-certificate-failure",
  sign: "web-eid:sign",
  signSuccess: "web-eid:sign-success",
  signFailure: "web-eid:sign-failure",
} as const;

/**
 * How long to wait for the extension to answer a handshake.
 *
 * Short: this runs on page load to render the setup checklist, and on a machine
 * with no extension there is nothing to wait for. The signing calls get no
 * timeout at all — the user may be reading a PIN dialog.
 */
const HANDSHAKE_TIMEOUT_MS = 2_000;

export function createWebEidSigningProvider(): SigningProvider {
  return {
    id: "webeid",

    async getReadiness(): Promise<ReadinessReport> {
      const checks: ReadinessCheck[] = [];

      const status = await handshake();
      const extensionPresent = status !== null;

      checks.push({
        id: "extension",
        label: "Web eID browser extension",
        status: extensionPresent ? "ok" : "missing",
        remedy: extensionPresent
          ? undefined
          : "Install the Web eID extension for your browser.",
        href: "https://www.id.ee/en/article/install-web-eid/",
      });

      checks.push({
        id: "native-host",
        label: "Web eID native application",
        // The extension answers the handshake only once it has reached the
        // native app, so a successful status covers both.
        status: extensionPresent ? "ok" : "unknown",
        remedy: extensionPresent
          ? undefined
          : "Installed together with the extension.",
      });

      checks.push({
        id: "middleware",
        label: "Autenticação.gov middleware (pteid)",
        // Nothing in the browser can see this directly; the extension only
        // reports it once a card operation is attempted.
        status: "unknown",
        remedy:
          "Install the Autenticação.gov application, which provides the PKCS#11 module the card needs.",
        href: "https://www.autenticacao.gov.pt/cc-aplicacao",
      });

      checks.push({
        id: "reader",
        label: "Smart card reader",
        status: "unknown",
        remedy: "Connect a reader, or use a contactless reader with the card's CAN.",
      });

      checks.push({
        id: "card",
        label: "Cartão de Cidadão",
        status: "unknown",
        remedy:
          "Portuguese card support needs a Web eID build that recognises the Cartão de Cidadão. See docs/adr/004-card-signing-companion.md — this is not yet available.",
      });

      return {
        providerId: "webeid",
        // Deliberately never `true` yet: the fork that recognises the card does
        // not exist, so claiming readiness would be a lie the user only
        // discovers at the PIN dialog that never appears.
        ready: false,
        checks,
      };
    },

    async getSigningCertificate(): Promise<SigningCertificate> {
      await requireExtension();

      const response = await send(ACTION.getCertificate, {
        // Web eID binds a signature to the origin that requested it.
        origin: window.location.origin,
      });

      const certificateBase64 = String(response.certificate ?? "");
      if (!certificateBase64) {
        throw new SigningError("not-ready", "The card returned no certificate.");
      }

      const info = readCertificate(fromBase64(certificateBase64));
      const supported = (response.supportedSignatureAlgorithms ?? []) as Array<{
        cryptoAlgorithm: string;
        hashFunction: string;
        paddingScheme: string;
      }>;

      return {
        certificateDer: certificateBase64,
        chainDer: [],
        subject: info.subject,
        issuer: info.issuer,
        serial: info.serial,
        notBefore: info.notBefore,
        notAfter: info.notAfter,
        keyType: info.keyType,
        supportedAlgorithms: supported
          .map(toJwsAlgorithm)
          .filter((a): a is SignatureAlgorithm => a !== null),
      };
    },

    async sign(request: SignRequest): Promise<SignResult> {
      await requireExtension();

      // The device is given the digest of SignedInfo, not SignedInfo itself:
      // that is what the two-step remote-signing shape passes to a card.
      const hash = await crypto.subtle.digest(
        request.hash,
        request.dataToBeSigned.buffer.slice(
          request.dataToBeSigned.byteOffset,
          request.dataToBeSigned.byteOffset + request.dataToBeSigned.byteLength,
        ) as ArrayBuffer,
      );

      const response = await send(ACTION.sign, {
        origin: window.location.origin,
        certificate: request.expectCertificateDer,
        hash: base64(new Uint8Array(hash)),
        hashFunction: request.hash,
      });

      const algorithm = toJwsAlgorithm(
        response.signatureAlgorithm as {
          cryptoAlgorithm: string;
          hashFunction: string;
          paddingScheme: string;
        },
      );

      if (!algorithm) {
        throw new SigningError(
          "unsupported-algorithm",
          "The card signed with an algorithm this application cannot express as XAdES.",
        );
      }

      return {
        signatureValue: String(response.signature ?? ""),
        algorithm,
        certificateDer: request.expectCertificateDer,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

type Message = Record<string, unknown> & { action?: string };

/**
 * Is the extension there?
 *
 * Resolves to null on timeout rather than throwing: a machine with no extension
 * is the ordinary case that `/sign/setup` exists to explain, not an error.
 */
async function handshake(): Promise<Message | null> {
  if (typeof window === "undefined") return null;

  try {
    return await request(
      ACTION.status,
      {},
      [ACTION.statusSuccess, ACTION.statusAck],
      [ACTION.statusFailure],
      HANDSHAKE_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
}

/**
 * Fail fast when there is no extension.
 *
 * The card operations themselves are given no timeout, because the user may be
 * looking at a PIN dialog and cancelling from underneath them would be worse
 * than waiting. But that reasoning does not apply *before* a dialog can exist:
 * without this handshake, pressing Sign on a machine with no extension left the
 * page saying "Reading the signing certificate from the card…" forever, with no
 * error and no way back.
 */
async function requireExtension(): Promise<void> {
  if ((await handshake()) === null) {
    throw new SigningError(
      "not-ready",
      "The Web eID extension did not respond. Check your signing setup.",
    );
  }
}

async function send(action: string, payload: Message): Promise<Message> {
  const success = `${action}-success`;
  const failure = `${action}-failure`;

  // No timeout: the user may be looking at a PIN dialog, and cancelling their
  // operation from underneath them because a timer expired would be worse than
  // waiting.
  return request(action, payload, [success], [failure], null);
}

function request(
  action: string,
  payload: Message,
  successActions: string[],
  failureActions: string[],
  timeoutMs: number | null,
): Promise<Message> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };

    const onMessage = (event: MessageEvent) => {
      // Only same-origin: the content script relays into this window, and
      // accepting anything else would let any frame answer for the card.
      if (event.source !== window) return;

      const message = event.data as Message | undefined;
      if (!message?.action) return;

      if (successActions.includes(message.action)) {
        finish(() => resolve(message));
      } else if (failureActions.includes(message.action)) {
        finish(() => reject(toSigningError(message)));
      }
    };

    window.addEventListener("message", onMessage);

    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(
            () =>
              finish(() =>
                reject(
                  new SigningError(
                    "not-ready",
                    "The Web eID extension did not respond.",
                  ),
                ),
              ),
            timeoutMs,
          );

    window.postMessage({ action, ...payload }, window.location.origin);
  });
}

function toSigningError(message: Message): SigningError {
  const code = String(message.code ?? message.error ?? "");
  const text = String(message.message ?? "The card operation failed.");

  if (/cancel|abort/i.test(code + text)) {
    return new SigningError("cancelled", "The signature was cancelled.");
  }
  if (/blocked/i.test(code + text)) {
    return new SigningError(
      "pin-blocked",
      "The signature PIN is blocked. Unblock it with the Autenticação.gov application.",
    );
  }
  if (/pin/i.test(code + text)) {
    return new SigningError("pin-incorrect", "The PIN was not accepted.");
  }
  return new SigningError("unknown", text);
}

/**
 * Web eID reports the algorithm as a triple; XAdES needs a JWS-style name.
 *
 * The RSA/ECDSA split is read from what the card actually reports — a CC v1
 * says RSA, a CC v2 says ECDSA — never assumed. That is the rule from the brief
 * and ADR 004.
 */
function toJwsAlgorithm(
  algorithm:
    | { cryptoAlgorithm: string; hashFunction: string; paddingScheme: string }
    | undefined,
): SignatureAlgorithm | null {
  if (!algorithm) return null;

  const bits = /(\d{3})/.exec(algorithm.hashFunction ?? "")?.[1];
  if (!bits) return null;

  const crypto_ = (algorithm.cryptoAlgorithm ?? "").toUpperCase();
  const padding = (algorithm.paddingScheme ?? "").toUpperCase();

  if (crypto_ === "ECDSA") return `ES${bits}` as SignatureAlgorithm;
  if (crypto_ === "RSA") {
    return padding.includes("PSS")
      ? (`PS${bits}` as SignatureAlgorithm)
      : (`RS${bits}` as SignatureAlgorithm);
  }
  return null;
}
