/**
 * The Cartão de Cidadão, through the DiCE-IFC signing companion.
 *
 * The companion is a small local service (see `companion/` in this repo) that
 * drives `pteidpkcs11` over PKCS#11. A browser cannot reach a smart card —
 * WebCrypto has no token access and WebAuthn cannot drive an arbitrary
 * qualified signing key — so something has to run on the machine. ADR 007
 * records why it is this rather than the Web eID extension ADR 004 chose.
 *
 * **The companion is a device, not a signing service.** It answers with a
 * certificate and signs. The XAdES signature and the ASiC-E container are still
 * built here, in the browser, by `xades.ts` and `asice.ts` — the code that 40
 * tests cover with real RSA and ECDSA keys. The only thing that crosses to
 * localhost is `SignedInfo`: digests, URIs and algorithm identifiers, from
 * which no document can be reconstructed.
 *
 * It never receives a model, and there is no PIN anywhere in this file. The
 * middleware raises its own PIN window.
 */

import { base64, fromBase64 } from "../canonical";
import { readCertificate } from "../der";
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
import {
  getCompanionSettings,
  getPairedSettings,
  repairCompanion,
} from "../companion-settings";

/**
 * Short, because `/status` is polled to render the setup checklist and a
 * companion that is not running should be reported as such immediately.
 * The signing call gets no timeout — see `sign`.
 */
const STATUS_TIMEOUT_MS = 2_500;

type StatusResponse = {
  version?: string;
  middleware?: string | null;
  reader?: string | null;
  cardPresent?: boolean;
  ready?: boolean;
  paired?: boolean;
};

export function createCompanionSigningProvider(): SigningProvider {
  return {
    id: "companion",

    async getReadiness(): Promise<ReadinessReport> {
      const { url } = getCompanionSettings();

      // Pair as part of the check. A companion that is running is a companion
      // that is ready — there is no configuration step in between.
      let { token } = await getPairedSettings();
      let status = await fetchStatus(url, token);

      // A companion that restarted issued a new token; the cached one is stale
      // rather than wrong, so re-pair instead of reporting a fault.
      if (status && token && !status.paired) {
        token = await repairCompanion(url);
        status = await fetchStatus(url, token);
      }

      // Nothing answered *this page*. Is anything listening at all? A companion
      // that refuses this site's origin looks exactly like one that is not
      // running — the browser hides the reason — and the two have opposite
      // remedies. A no-cors request is not subject to the allow-list and
      // succeeds (opaquely) whenever something is there.
      const refusing = !status && (await isListening(url));

      const checks: ReadinessCheck[] = [
        {
          id: "native-host",
          label: "DiCE-IFC signing companion",
          status: status ? "ok" : "missing",
          remedy: status
            ? undefined
            : refusing
              ? `The companion is running, but it does not accept this site (${window.location.origin}). Install the companion offered below, which is built for this site — or add ${window.location.origin} to the companion's allowed origins (see companion/packaging/README.md) and restart it.`
              : "Not running. Download and install it below, then start it — this page pairs with it by itself.",
        },
        {
          id: "middleware",
          label: "Autenticação.gov middleware (pteid)",
          status: status?.middleware ? "ok" : status ? "missing" : "unknown",
          remedy: status?.middleware
            ? undefined
            : "Install the Autenticação.gov application — it provides the PKCS#11 module the card needs.",
          href: "https://www.autenticacao.gov.pt/cc-aplicacao",
        },
        {
          id: "reader",
          label: status?.reader ? `Reader — ${status.reader}` : "Smart card reader",
          status: status?.reader ? "ok" : status ? "missing" : "unknown",
          remedy: status?.reader
            ? undefined
            : "Connect a card reader, or use a contactless reader with the card's CAN.",
        },
        {
          id: "card",
          label: "Cartão de Cidadão",
          status: status?.cardPresent ? "ok" : status ? "missing" : "unknown",
          remedy: status?.cardPresent ? undefined : "Insert the card into the reader.",
        },
        {
          id: "extension",
          label: "Paired with this browser",
          status: status?.paired ? "ok" : "missing",
          remedy: status?.paired
            ? undefined
            : "The companion is running but did not pair. Update it — versions before 0.1.1 have no /pair endpoint and needed a token pasted by hand.",
        },
      ];

      return {
        providerId: "companion",
        ready: Boolean(status?.ready && status?.paired),
        checks,
      };
    },

    async getSigningCertificate(): Promise<SigningCertificate> {
      const { url, token } = await getPairedSettings();
      const response = await call(url, token, "/certificate");

      const certificateDer = String(response.certificate ?? "");
      if (!certificateDer) {
        throw new SigningError("not-ready", "The card returned no certificate.");
      }

      const info = readCertificate(fromBase64(certificateDer));

      return {
        certificateDer,
        chainDer: (response.chain ?? []) as string[],
        subject: info.subject,
        issuer: info.issuer,
        serial: info.serial,
        notBefore: info.notBefore,
        notAfter: info.notAfter,
        keyType: info.keyType,
        // Read from the certificate, never assumed: a CC v1 is RSA and a CC v2
        // (June 2024+) is ECDSA. The companion picks its PKCS#11 mechanism the
        // same way, from the key type the card reports.
        supportedAlgorithms:
          info.keyType === "EC"
            ? (["ES512", "ES384", "ES256"] as SignatureAlgorithm[])
            : (["RS512", "RS384", "RS256"] as SignatureAlgorithm[]),
      };
    },

    async sign(request: SignRequest): Promise<SignResult> {
      const { url, token } = await getPairedSettings();

      // `SignedInfo`, not the document — a few hundred bytes of digests, URIs
      // and algorithm names. This is the entire payload that crosses to
      // localhost, and the model is not recoverable from it.
      //
      // The bytes rather than their hash because a Cartão de Cidadão refuses
      // CKM_RSA_PKCS for the signature key and hashes internally; the companion
      // still tries the digest-only mechanism first.
      const response = await call(url, token, "/sign", {
        data: base64(request.dataToBeSigned),
        hash: request.hash,
        certificate: request.expectCertificateDer,
      });

      const algorithm = String(response.algorithm ?? "") as SignatureAlgorithm;
      if (!/^(RS|PS|ES)(256|384|512)$/.test(algorithm)) {
        throw new SigningError(
          "unsupported-algorithm",
          `The card signed with "${algorithm}", which cannot be expressed as XAdES.`,
        );
      }

      return {
        signatureValue: String(response.signature ?? ""),
        algorithm,
        certificateDer: String(response.certificate ?? request.expectCertificateDer),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Is anything answering at `url`, whether or not it will talk to this page? */
async function isListening(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/status`, { mode: "no-cors", signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

async function fetchStatus(
  url: string,
  token: string,
): Promise<StatusResponse | null> {
  try {
    const response = await fetch(`${url}/status`, {
      headers: token ? { "X-DiCE-Token": token } : {},
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as StatusResponse;
  } catch {
    // A companion that is not running is the ordinary state of a fresh machine,
    // which the setup page exists to explain — not an exception.
    return null;
  }
}

async function call(
  url: string,
  token: string,
  path: string,
  body?: unknown,
  /** Cleared on the retry, so a companion answering 403 twice is a real error. */
  retry = true,
): Promise<Record<string, unknown>> {
  if (!token) {
    throw new SigningError(
      "not-ready",
      `No signing companion is answering at ${url}. Install it from Signing setup and start it — pairing is automatic.`,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "X-DiCE-Token": token,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // No timeout. The citizen may be reading a PIN window, and cancelling
      // their operation because a timer expired would be worse than waiting.
    });
  } catch {
    throw new SigningError(
      "not-ready",
      `The signing companion at ${url} could not be reached. Is it running?`,
    );
  }

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (response.status === 403 && retry) {
    // The companion restarted and minted a new token. Pair again and repeat the
    // call once; a citizen halfway through signing should not have to know that
    // happened.
    const fresh = await repairCompanion(url);
    if (fresh && fresh !== token) return call(url, fresh, path, body, false);
  }

  if (!response.ok) {
    throw new SigningError(
      codeFor(String(payload.code ?? "")),
      String(payload.error ?? `The companion returned ${response.status}.`),
    );
  }
  return payload;
}

/** The companion's own error codes map onto ours one for one. */
function codeFor(code: string) {
  switch (code) {
    case "cancelled":
      return "cancelled" as const;
    case "pin-incorrect":
      return "pin-incorrect" as const;
    case "pin-blocked":
      return "pin-blocked" as const;
    case "card-changed":
      return "card-changed" as const;
    case "forbidden":
    case "no-middleware":
    case "no-card":
    case "no-signature-key":
      return "not-ready" as const;
    case "unsupported":
      return "unsupported-algorithm" as const;
    default:
      return "unknown" as const;
  }
}
