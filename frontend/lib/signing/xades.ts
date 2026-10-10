/**
 * XAdES-B signature builder.
 *
 * Two-step, deliberately: `prepareSignature()` produces the bytes to be signed,
 * the device signs them, and `completeSignature()` assembles the final XML. That
 * is the same get-data-to-sign / sign-with-value shape EU DSS uses for remote
 * signing, and it is the only shape that works here — the private key is on a
 * card behind a PIN dialog we never see, so the builder cannot simply "sign".
 *
 * ## What is signed
 *
 * Two `ds:Reference` elements per data object plus one for the signed
 * properties:
 *
 * - one Reference per file, `URI="name.ifc"`, digest over the file's **bytes
 *   exactly as read**. Never re-serialised: a STEP round-trip reorders
 *   instances and rewrites the header, which silently invalidates the signature.
 * - one Reference to `#…-signedprops`, `Type="…#SignedProperties"`, digest over
 *   the canonical `SignedProperties` — which carries the signing time and the
 *   signing certificate's digest, binding both into the signature.
 *
 * `SignedInfo` then covers all of those, and the device signs `SignedInfo`.
 *
 * ## Canonicalisation
 *
 * Every fragment that is hashed on its own is put through `c14n.ts` first, and
 * the canonical string is what gets hashed **and** what gets embedded — so the
 * bytes in the file are the bytes that were signed.
 *
 * This used to rely on emitting canonical XML directly (ADR 006). That premise
 * was wrong in one specific way, and wrong in the direction that matters:
 * exclusive c14n renders a namespace declaration on the element that *visibly
 * utilises* it, not hoisted to the root of the fragment. Our `SignedProperties`
 * declared `xmlns:ds` at its root because a `ds:DigestMethod` deep inside needs
 * it; canonical form declares it on that `ds:DigestMethod` instead. Our own
 * verifier agreed with our own mistake, so every test passed — and any
 * conforming verifier, including the official Portuguese one, would have
 * rejected the signature.
 *
 * ## Extending to T and LTA
 *
 * `UnsignedProperties` is deliberately a separate, appendable element: adding a
 * timestamp (XAdES-T) or validation data (LTA) is a later pass over an existing
 * container and must not disturb anything covered by a signature. Nothing here
 * writes it yet — `trust/` has to exist first — but the shape does not change.
 */

import { canonicalize } from "./c14n";
import {
  base64,
  digestBase64,
  element,
  serialize,
  signingTime,
  textElement,
  utf8,
  type XmlNode,
} from "./canonical";
import {
  hashForAlgorithm,
  xmldsigAlgorithmUri,
  xmldsigDigestUri,
  type HashAlgorithm,
  type SignatureAlgorithm,
  type SigningCertificate,
} from "./provider";

export const DS_NS = "http://www.w3.org/2000/09/xmldsig#";
export const XADES_NS = "http://uri.etsi.org/01903/v1.3.2#";
export const ASIC_NS = "http://uri.etsi.org/02918/v1.2.1#";
export const C14N_EXCLUSIVE = "http://www.w3.org/2001/10/xml-exc-c14n#";
export const SIGNED_PROPERTIES_TYPE = "http://uri.etsi.org/01903#SignedProperties";

/** A file covered by the signature. */
export type SignedDataObject = {
  /** Path inside the container, and the Reference `URI`. */
  name: string;
  bytes: Uint8Array;
  mimeType: string;
};

export type PreparedSignature = {
  /** The canonical `SignedInfo` — hand these bytes to the device. */
  dataToBeSigned: Uint8Array;
  hash: HashAlgorithm;
  algorithm: SignatureAlgorithm;
  /** Everything `completeSignature` needs to finish, once a value comes back. */
  context: SignatureContext;
};

export type SignatureContext = {
  signatureId: string;
  signedInfoXml: string;
  signedPropertiesXml: string;
  certificate: SigningCertificate;
  algorithm: SignatureAlgorithm;
  dataObjects: Array<{ name: string; referenceId: string; mimeType: string }>;
  signingTime: string;
};

export type PrepareOptions = {
  algorithm: SignatureAlgorithm;
  /** Injectable so tests produce byte-identical output. */
  now?: Date;
  /** Injectable for the same reason; must be unique within a container. */
  idSuffix?: string;
};

/**
 * Build everything up to the signature value.
 *
 * `dataObjects` may hold more than one file: that is the "one signature over a
 * manifest" mode from the brief — N references, one `SignedInfo`, one PIN
 * prompt. Per-file signing is the same function called N times.
 */
export async function prepareSignature(
  dataObjects: SignedDataObject[],
  certificate: SigningCertificate,
  options: PrepareOptions,
): Promise<PreparedSignature> {
  if (dataObjects.length === 0) {
    throw new Error("A signature must cover at least one file.");
  }

  const hash = hashForAlgorithm(options.algorithm);
  const suffix = options.idSuffix ?? randomSuffix();
  const signatureId = `sig-${suffix}`;
  const signedPropertiesId = `${signatureId}-signedprops`;
  const at = signingTime(options.now);

  const references = dataObjects.map((object, index) => ({
    object,
    referenceId: `${signatureId}-ref-${index}`,
  }));

  const signedProperties = buildSignedProperties({
    id: signedPropertiesId,
    at,
    hash,
    certificateDigest: await digestBase64(
      hash,
      fromBase64Certificate(certificate.certificateDer),
    ),
    certificate,
    dataObjects: references.map(({ object, referenceId }) => ({
      referenceId,
      mimeType: object.mimeType,
    })),
  });

  const signedPropertiesXml = toCanonical(signedProperties);

  const signedInfo = element(
    "ds:SignedInfo",
    [{ name: "xmlns:ds", value: DS_NS }],
    [
      element("ds:CanonicalizationMethod", [
        { name: "Algorithm", value: C14N_EXCLUSIVE },
      ]),
      element("ds:SignatureMethod", [
        { name: "Algorithm", value: xmldsigAlgorithmUri(options.algorithm) },
      ]),
      ...(await Promise.all(
        references.map(async ({ object, referenceId }) =>
          element(
            "ds:Reference",
            [
              { name: "Id", value: referenceId },
              // The file name, URI-encoded. A space in a model name would
              // otherwise produce a Reference URI no verifier can resolve.
              { name: "URI", value: encodeURI(object.name) },
            ],
            [
              element("ds:DigestMethod", [
                { name: "Algorithm", value: xmldsigDigestUri(hash) },
              ]),
              // The payload's own bytes, hashed as read.
              textElement("ds:DigestValue", await digestBase64(hash, object.bytes)),
            ],
          ),
        ),
      )),
      element(
        "ds:Reference",
        [
          { name: "Type", value: SIGNED_PROPERTIES_TYPE },
          { name: "URI", value: `#${signedPropertiesId}` },
        ],
        [
          element(
            "ds:Transforms",
            [],
            [
              element("ds:Transform", [
                { name: "Algorithm", value: C14N_EXCLUSIVE },
              ]),
            ],
          ),
          element("ds:DigestMethod", [
            { name: "Algorithm", value: xmldsigDigestUri(hash) },
          ]),
          textElement(
            "ds:DigestValue",
            await digestBase64(hash, utf8(signedPropertiesXml)),
          ),
        ],
      ),
    ],
  );

  const signedInfoXml = toCanonical(signedInfo);

  return {
    dataToBeSigned: utf8(signedInfoXml),
    hash,
    algorithm: options.algorithm,
    context: {
      signatureId,
      signedInfoXml,
      signedPropertiesXml,
      certificate,
      algorithm: options.algorithm,
      signingTime: at,
      dataObjects: references.map(({ object, referenceId }) => ({
        name: object.name,
        referenceId,
        mimeType: object.mimeType,
      })),
    },
  };
}

/**
 * Assemble the signature XML around a signature value.
 *
 * `signedInfoXml` goes in as the exact string that was hashed. Re-serialising
 * it here would be the classic way to produce a signature that verifies against
 * nothing: any difference, however cosmetic, changes the digest.
 */
export function completeSignature(
  context: SignatureContext,
  signatureValueBase64: string,
): string {
  const signature = element(
    "ds:Signature",
    [
      { name: "xmlns:ds", value: DS_NS },
      { name: "Id", value: context.signatureId },
    ],
    [
      { name: "__raw", text: context.signedInfoXml } as unknown as XmlNode,
      textElement("ds:SignatureValue", signatureValueBase64, [
        { name: "Id", value: `${context.signatureId}-value` },
      ]),
      element(
        "ds:KeyInfo",
        [],
        [
          element(
            "ds:X509Data",
            [],
            [
              textElement("ds:X509Certificate", context.certificate.certificateDer),
              ...context.certificate.chainDer.map((der) =>
                textElement("ds:X509Certificate", der),
              ),
            ],
          ),
        ],
      ),
      element(
        "ds:Object",
        [],
        [
          element(
            "xades:QualifyingProperties",
            [
              { name: "xmlns:xades", value: XADES_NS },
              { name: "Target", value: `#${context.signatureId}` },
            ],
            [{ name: "__raw", text: context.signedPropertiesXml } as unknown as XmlNode],
          ),
        ],
      ),
    ],
  );

  return serializeWithRaw(signature);
}

/**
 * Serialise, splicing in pre-serialised fragments verbatim.
 *
 * `SignedInfo` and `SignedProperties` were hashed as exact strings, so they have
 * to be embedded exactly, not rebuilt. The `__raw` marker is how they get past
 * the normal emitter without being re-escaped.
 */
function serializeWithRaw(node: XmlNode): string {
  if (node.name === "__raw") return node.text ?? "";

  const attributes = (node.attributes ?? []).slice();
  const namespaces = attributes.filter(
    (a) => a.name === "xmlns" || a.name.startsWith("xmlns:"),
  );
  const rest = attributes.filter(
    (a) => !(a.name === "xmlns" || a.name.startsWith("xmlns:")),
  );
  namespaces.sort((a, b) => (a.name === "xmlns" ? -1 : a.name.localeCompare(b.name)));
  rest.sort((a, b) => a.name.localeCompare(b.name));

  const rendered = [...namespaces, ...rest]
    .map((a) => ` ${a.name}="${escapeAttributeValue(a.value)}"`)
    .join("");

  const inner =
    node.text !== undefined
      ? escapeTextValue(node.text)
      : (node.children ?? []).map(serializeWithRaw).join("");

  return `<${node.name}${rendered}>${inner}</${node.name}>`;
}

function escapeAttributeValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#xD;");
}

function escapeTextValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#xD;");
}

// ---------------------------------------------------------------------------
// SignedProperties
// ---------------------------------------------------------------------------

/**
 * `SignedProperties` declares **both** `ds` and `xades`.
 *
 * Its subtree uses `xades:` throughout and `ds:DigestMethod`/`ds:DigestValue`
 * inside `CertDigest`, so exclusive c14n renders both declarations here when a
 * verifier canonicalises this fragment alone. Emitting them explicitly is what
 * makes our hashed bytes equal the verifier's.
 */
function buildSignedProperties(input: {
  id: string;
  at: string;
  hash: HashAlgorithm;
  certificateDigest: string;
  certificate: SigningCertificate;
  dataObjects: Array<{ referenceId: string; mimeType: string }>;
}): XmlNode {
  return element(
    "xades:SignedProperties",
    [
      { name: "xmlns:ds", value: DS_NS },
      { name: "xmlns:xades", value: XADES_NS },
      { name: "Id", value: input.id },
    ],
    [
      element(
        "xades:SignedSignatureProperties",
        [],
        [
          textElement("xades:SigningTime", input.at),
          element(
            "xades:SigningCertificateV2",
            [],
            [
              element(
                "xades:Cert",
                [],
                [
                  element(
                    "xades:CertDigest",
                    [],
                    [
                      element("ds:DigestMethod", [
                        { name: "Algorithm", value: xmldsigDigestUri(input.hash) },
                      ]),
                      textElement("ds:DigestValue", input.certificateDigest),
                    ],
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
      element(
        "xades:SignedDataObjectProperties",
        [],
        input.dataObjects.map((object) =>
          element(
            "xades:DataObjectFormat",
            [{ name: "ObjectReference", value: `#${object.referenceId}` }],
            [textElement("xades:MimeType", object.mimeType)],
          ),
        ),
      ),
    ],
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialise, then canonicalise.
 *
 * The round trip through `DOMParser` is the point: it is the same path a
 * verifier takes, so what we hash is what they will hash.
 */
function toCanonical(node: XmlNode): string {
  const raw = serialize(node);
  const document_ = new DOMParser().parseFromString(raw, "application/xml");

  if (document_.querySelector("parsererror")) {
    throw new Error("The signature fragment was not well-formed XML.");
  }
  return canonicalize(document_.documentElement);
}

function fromBase64Certificate(der: string): Uint8Array {
  const binary = atob(der.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomSuffix(): string {
  return base64(crypto.getRandomValues(new Uint8Array(9)))
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

/** The ASiC-E wrapper a `META-INF/signaturesNNN.xml` needs. */
export function wrapAsicSignatures(signatureXml: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<asic:XAdESSignatures xmlns:asic="${ASIC_NS}">` +
    signatureXml +
    `</asic:XAdESSignatures>`
  );
}
