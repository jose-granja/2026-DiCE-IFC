/** Detached CMS, SHA-256 / RSA or P-256. RFC 5652; no certificate trust check. */
import { base64, digest, fromBase64 } from "./canonical";
import {
  concat, encode, explicit, integer, nullValue, oid, readCertificate,
  readChildren, readNode, readOid, sequence, set, utcTime, type DerNode,
} from "./der";
import { SigningError, type SigningCertificate, type SignResult } from "./provider";

const O = {
  data: "1.2.840.113549.1.7.1", signedData: "1.2.840.113549.1.7.2",
  sha256: "2.16.840.1.101.3.4.2.1", rsa: "1.2.840.113549.1.1.1",
  rsa256: "1.2.840.113549.1.1.11", ec: "1.2.840.10045.2.1",
  p256: "1.2.840.10045.3.1.7", es256: "1.2.840.10045.4.3.2",
  contentType: "1.2.840.113549.1.9.3", messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5", signingCert: "1.2.840.113549.1.9.16.2.47",
};
const hashId = () => sequence(oid(O.sha256), nullValue());
const attr = (id: string, value: Uint8Array) => sequence(oid(id), set(value));
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const buffer = (a: Uint8Array) => new Uint8Array(a).buffer;
const compare = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error("Unsupported or malformed CMS signature.");
}
function children(node: DerNode, tag = 0x30): DerNode[] {
  requireValue(node?.tag === tag);
  return readChildren(node);
}
function id(node: DerNode): string {
  requireValue(node?.tag === 6);
  return readOid(node.content);
}
function algorithm(node: DerNode): string {
  const parts = children(node);
  requireValue(parts.length === 1 || (parts.length === 2 && parts[1].tag === 5 && parts[1].content.length === 0));
  return id(parts[0]);
}
function certificateParts(bytes: Uint8Array, checkKey = true) {
  const root = readNode(bytes);
  requireValue(root.full.length === bytes.length);
  const certificate = children(root);
  requireValue(certificate.length === 3);
  const fields = children(certificate[0]);
  const offset = fields[0].tag === 0xa0 ? 1 : 0;
  const serial = fields[offset], issuer = fields[offset + 2], spki = fields[offset + 5];
  requireValue(serial?.tag === 2 && issuer?.tag === 0x30);
  const [alg] = children(spki);
  const key = children(alg);
  const keyOid = id(key[0]);
  if (checkKey) requireValue(keyOid === O.rsa || (keyOid === O.ec && key.length === 2 && id(key[1]) === O.p256));
  return { serial, issuer, spki, ec: keyOid === O.ec };
}

/** Convert PKCS#11 / WebCrypto r||s into the DER pair required by CMS. */
export function ecSignatureToDer(raw: Uint8Array): Uint8Array {
  requireValue(raw.length === 64);
  const part = (value: Uint8Array) => {
    let first = 0;
    while (first < value.length - 1 && value[first] === 0) first++;
    return integer(value.subarray(first));
  };
  return sequence(part(raw.subarray(0, 32)), part(raw.subarray(32)));
}
function ecSignatureFromDer(der: Uint8Array): Uint8Array {
  const root = readNode(der), values = children(root);
  requireValue(root.full.length === der.length && values.length === 2);
  const raw = new Uint8Array(64);
  values.forEach((value, index) => {
    requireValue(value.tag === 2 && value.content.length > 0 && !(value.content[0] & 0x80));
    const bytes = value.content[0] === 0 ? value.content.subarray(1) : value.content;
    requireValue(bytes.length <= 32);
    raw.set(bytes, (index + 1) * 32 - bytes.length);
  });
  requireValue(equal(ecSignatureToDer(raw), der));
  return raw;
}

export async function prepareCms(contentDigest: Uint8Array, certificate: SigningCertificate, at = new Date()) {
  requireValue(contentDigest.length === 32);
  const leaf = fromBase64(certificate.certificateDer);
  const parts = certificateParts(leaf);
  const chosen = parts.ec ? "ES256" : "RS256";
  if (!certificate.supportedAlgorithms.includes(chosen)) {
    throw new SigningError("unsupported-algorithm", "The card must support SHA-256 with RSA or P-256.");
  }
  const attributes = [
    attr(O.contentType, oid(O.data)),
    attr(O.messageDigest, encode(4, contentDigest)),
    attr(O.signingTime, utcTime(at)),
    // ESS SigningCertificateV2, default SHA-256, binds the exact certificate.
    attr(O.signingCert, sequence(sequence(sequence(encode(4, await digest("SHA-256", leaf)))))),
  ].sort(compare);
  const dataToBeSigned = set(...attributes);
  return {
    algorithm: chosen,
    hash: "SHA-256" as const,
    dataToBeSigned,
    complete(result: SignResult): Uint8Array {
      if (!equal(fromBase64(result.certificateDer), leaf)) {
        throw new SigningError("card-changed", "The signing certificate changed.");
      }
      if (result.algorithm !== chosen) throw new SigningError("unsupported-algorithm", "Unexpected signature algorithm.");
      const signature = fromBase64(result.signatureValue);
      const certificates = [leaf, ...certificate.chainDer.map(fromBase64)]
        .filter((cert, i, all) => all.findIndex((other) => equal(cert, other)) === i).sort(compare);
      const signer = sequence(integer(1), sequence(parts.issuer.full, parts.serial.full), hashId(),
        encode(0xa0, concat(...attributes)),
        parts.ec ? sequence(oid(O.es256)) : sequence(oid(O.rsa), nullValue()),
        encode(4, parts.ec ? ecSignatureToDer(signature) : signature));
      return sequence(oid(O.signedData), explicit(0, sequence(integer(1), set(hashId()),
        sequence(oid(O.data)), encode(0xa0, concat(...certificates)), set(signer))));
    },
  };
}

export type CmsVerification = {
  valid: boolean;
  certificate?: SigningCertificate;
  signingTime?: string;
};

/** Restricted to detached, single-signer SHA-256 CMS with signed attributes.
 * Unknown profiles fail closed. This proves integrity only, never trust or time. */
export async function verifyCms(cms: Uint8Array, contentDigest: Uint8Array): Promise<CmsVerification> {
  try {
    requireValue(contentDigest.length === 32 && cms.length < 1024 * 1024);
    const root = readNode(cms), info = children(root);
    requireValue(root.full.length === cms.length && info.length === 2 && id(info[0]) === O.signedData);
    const wrapped = children(info[1], 0xa0);
    requireValue(wrapped.length === 1);
    const sd = children(wrapped[0]);
    requireValue(sd.length === 5 && equal(sd[0].full, integer(1)));
    const hashes = children(sd[1], 0x31), content = children(sd[2]);
    requireValue(hashes.length === 1 && algorithm(hashes[0]) === O.sha256 && content.length === 1 && id(content[0]) === O.data);
    const certs = children(sd[3], 0xa0), signers = children(sd[4], 0x31);
    requireValue(certs.length > 0 && certs.length <= 16 && signers.length === 1);
    const si = children(signers[0]);
    requireValue(si.length === 6 && equal(si[0].full, integer(1)) && algorithm(si[2]) === O.sha256);
    const sid = children(si[1]);
    requireValue(sid.length === 2);
    const candidates = certs.filter((cert) => {
      const parts = certificateParts(cert.full, false);
      return equal(parts.issuer.full, sid[0].full) && equal(parts.serial.full, sid[1].full);
    });
    requireValue(candidates.length === 1);
    const leaf = candidates[0].full, parts = certificateParts(leaf);
    const sigAlgorithm = algorithm(si[4]);
    requireValue(parts.ec ? sigAlgorithm === O.es256 : sigAlgorithm === O.rsa || sigAlgorithm === O.rsa256);
    const attrs = children(si[3], 0xa0);
    const attributes = new Map<string, DerNode>();
    attrs.forEach((attribute, index) => {
      if (index) requireValue(compare(attrs[index - 1].full, attribute.full) <= 0);
      const pair = children(attribute);
      requireValue(pair.length === 2);
      const key = id(pair[0]), values = children(pair[1], 0x31);
      requireValue(!attributes.has(key) && values.length === 1);
      attributes.set(key, values[0]);
    });
    requireValue(id(attributes.get(O.contentType)!) === O.data);
    const message = attributes.get(O.messageDigest);
    requireValue(message?.tag === 4 && equal(message.content, contentDigest));
    const binding = attributes.get(O.signingCert);
    if (binding) {
      const outer = children(binding);
      requireValue(outer.length === 1);
      const certIds = children(outer[0]);
      requireValue(certIds.length === 1);
      const certId = children(certIds[0]);
      requireValue(certId.length === 1 && certId[0].tag === 4 && equal(certId[0].content, await digest("SHA-256", leaf)));
    }
    requireValue(si[5].tag === 4);
    const key = await crypto.subtle.importKey("spki", buffer(parts.spki.full), parts.ec
      ? { name: "ECDSA", namedCurve: "P-256" }
      : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(parts.ec ? { name: "ECDSA", hash: "SHA-256" } : "RSASSA-PKCS1-v1_5",
      key, buffer(parts.ec ? ecSignatureFromDer(si[5].content) : si[5].content), buffer(encode(0x31, si[3].content)));
    const parsed = readCertificate(leaf);
    const time = attributes.get(O.signingTime);
    let signingTime: string | undefined;
    if (time) {
      requireValue(time.tag === 0x17);
      const raw = new TextDecoder().decode(time.content);
      requireValue(/^\d{12}Z$/.test(raw));
      signingTime = `${Number(raw.slice(0, 2)) >= 50 ? "19" : "20"}${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}T${raw.slice(6, 8)}:${raw.slice(8, 10)}:${raw.slice(10, 12)}Z`;
    }
    return { valid, signingTime, certificate: { ...parsed, certificateDer: base64(leaf),
      chainDer: [], supportedAlgorithms: [parts.ec ? "ES256" : "RS256"] } };
  } catch {
    return { valid: false };
  }
}
