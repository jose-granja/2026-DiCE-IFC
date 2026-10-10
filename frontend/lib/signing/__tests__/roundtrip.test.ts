// @vitest-environment jsdom

/**
 * Sign, then verify — with real keys.
 *
 * The `software` provider generates a genuine WebCrypto key pair and a genuine
 * self-signed certificate, so these are real signatures over real digests. That
 * is the only way to know the canonical-XML approach in `canonical.ts` is
 * correct: if the bytes we hash differ from the bytes a verifier re-canonicalises
 * by so much as an attribute order, the signature fails, and nothing else in the
 * suite would notice.
 *
 * **Both key types run every test.** A Cartão de Cidadão v1 is RSA and a v2
 * (June 2024+) is ECDSA, and the brief is explicit that the algorithm must never
 * be hard-coded. Parameterising here is what proves it is not.
 */

import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { addSignature, createContainer, listSignatureFiles } from "../asice";
import { fromBase64 } from "../canonical";
import { readCertificate } from "../der";
import { createSoftwareSigningProvider } from "../providers/software";
import { signFiles } from "../sign";
import { verifyContainer } from "../verify";
import type { KeyType } from "../provider";

const MODEL = new TextEncoder().encode(
  "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'');\nENDSEC;\nDATA;\n#1=IFCWALL('x',$);\nENDSEC;\nEND-ISO-10303-21;\n",
);
const OTHER = new TextEncoder().encode("ISO-10303-21;\n/* second model */\nEND-ISO-10303-21;\n");

/** A minimal, genuinely valid BCF zip — one topic, no snapshot or viewpoint. */
const TOPIC_GUID = "9f6c8f5e-1a2b-4c3d-9e0f-abc123456789";
const BCF = zipSync({
  "bcf.version": new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="3.0" xmlns="http://www.buildingsmart-tech.org/specifications/bcf-version"/>\n',
  ),
  [`${TOPIC_GUID}/markup.bcf`]: new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Markup xmlns="http://www.buildingsmart-tech.org/specifications/bcf-Markup-xsd"><Topic Guid="${TOPIC_GUID}"><Title>Test</Title></Topic></Markup>\n`,
  ),
});

const KEY_TYPES: KeyType[] = ["RSA", "EC"];

describe.each(KEY_TYPES)("signing with a %s card", (keyType) => {
  const provider = () => createSoftwareSigningProvider({ keyType });

  it("produces a container whose signature verifies", async () => {
    const [output] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      await provider(),
    );

    const result = await verifyContainer(output.bytes);

    expect(result.problems).toEqual([]);
    expect(result.signatures).toHaveLength(1);
    expect(result.signatures[0].signatureValid).toBe(true);
    expect(result.signatures[0].valid).toBe(true);
  });

  it("covers the payload bytes exactly as given", async () => {
    const [output] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      await provider(),
    );

    // Never re-serialised: a STEP round-trip would reorder instances and
    // rewrite the header, and the signature would no longer match its payload.
    // Compared as plain arrays: `toEqual` on two Uint8Arrays from different
    // realms (jsdom's vs node's) fails on constructor identity even when every
    // byte matches, and reports "no visual difference", which is baffling.
    const entries = unzipSync(output.bytes);
    expect([...entries["model.ifc"]]).toEqual([...MODEL]);
  });

  it("detects a tampered payload", async () => {
    // The whole point. If this passes, nothing else here means anything.
    const [output] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      await provider(),
    );

    const entries = unzipSync(output.bytes);
    entries["model.ifc"] = new TextEncoder().encode("ISO-10303-21;\nTAMPERED\n");

    const { zipSync } = await import("fflate");
    const result = await verifyContainer(zipSync(entries));

    // The signature over SignedInfo is still mathematically fine — it is the
    // reference digest that no longer matches, which is exactly how XMLDSig
    // localises tampering.
    expect(result.signatures[0].signatureValid).toBe(true);
    expect(result.signatures[0].references[0].digestMatches).toBe(false);
    expect(result.signatures[0].valid).toBe(false);
  });

  it("detects a tampered signature value", async () => {
    const [output] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      await provider(),
    );

    const entries = unzipSync(output.bytes);
    const xml = new TextDecoder()
      .decode(entries["META-INF/signatures001.xml"])
      .replace(/<ds:SignatureValue([^>]*)>[^<]+</, "<ds:SignatureValue$1>AAAA<");
    entries["META-INF/signatures001.xml"] = new TextEncoder().encode(xml);

    const { zipSync } = await import("fflate");
    const result = await verifyContainer(zipSync(entries));

    expect(result.signatures[0].signatureValid).toBe(false);
    expect(result.signatures[0].valid).toBe(false);
  });

  it("detects a tampered signing time", async () => {
    // SigningTime lives in SignedProperties, which has its own Reference — so
    // editing it breaks that digest even though the payload is untouched.
    const [output] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      await provider(),
    );

    const entries = unzipSync(output.bytes);
    const xml = new TextDecoder()
      .decode(entries["META-INF/signatures001.xml"])
      .replace(/<xades:SigningTime>[^<]+<\/xades:SigningTime>/, "<xades:SigningTime>2001-01-01T00:00:00Z</xades:SigningTime>");
    entries["META-INF/signatures001.xml"] = new TextEncoder().encode(xml);

    const { zipSync } = await import("fflate");
    const result = await verifyContainer(zipSync(entries));

    const signedProperties = result.signatures[0].references.find((r) =>
      r.uri.startsWith("#"),
    );
    expect(signedProperties?.digestMatches).toBe(false);
    expect(result.signatures[0].valid).toBe(false);
  });

  it("signs several files under one signature in combined mode", async () => {
    const [output] = await signFiles(
      [
        { name: "architecture.ifc", bytes: MODEL },
        { name: "structure.ifc", bytes: OTHER },
      ],
      await provider(),
      { mode: "combined" },
    );

    const result = await verifyContainer(output.bytes);

    expect(result.signatures).toHaveLength(1);
    expect(result.signatures[0].valid).toBe(true);
    // One reference per file, plus the SignedProperties one.
    expect(result.signatures[0].references).toHaveLength(3);
    expect(output.covers).toEqual(["architecture.ifc", "structure.ifc"]);
  });

  it("asks for the PIN once in combined mode and once per file otherwise", async () => {
    const device = await provider();
    let prompts = 0;
    const counting = {
      ...device,
      sign: (request: Parameters<typeof device.sign>[0]) => {
        prompts += 1;
        return device.sign(request);
      },
    };

    const files = [
      { name: "a.ifc", bytes: MODEL },
      { name: "b.ifc", bytes: OTHER },
    ];

    await signFiles(files, counting, { mode: "combined" });
    expect(prompts).toBe(1);

    prompts = 0;
    const outputs = await signFiles(files, counting, { mode: "per-file" });
    expect(prompts).toBe(2);
    expect(outputs).toHaveLength(2);

    // Each container is independently verifiable — the guarantee per-file mode
    // exists to provide.
    for (const output of outputs) {
      const result = await verifyContainer(output.bytes);
      expect(result.signatures[0].valid).toBe(true);
    }
  });

  it("reports the certificate it was signed with", async () => {
    const device = await provider();
    const certificate = await device.getSigningCertificate();
    const [output] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      device,
    );

    const result = await verifyContainer(output.bytes);

    expect(result.signatures[0].subject).toBe(certificate.subject);
    expect(result.signatures[0].serial).toBe(certificate.serial);
    expect(result.signatures[0].algorithm).toContain(
      keyType === "EC" ? "ECDSA" : "RSA",
    );
  });

  it("never claims a valid signature is a trusted one", async () => {
    // Chain, revocation and timestamp all need the `trust/` proxy. Saying
    // "trusted" here would be the most damaging thing this module could do.
    const [output] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      await provider(),
    );

    const result = await verifyContainer(output.bytes);
    expect(result.signatures[0].trust).toBe("not-checked");
  });
});

describe("co-signing", () => {
  it("adds a second signature without disturbing the first", async () => {
    // Author, then reviewer: ASiC-E numbers signature files, so this needs no
    // special format.
    const author = await createSoftwareSigningProvider({
      keyType: "RSA",
      subject: [["CN", "AUTHOR"], ["C", "PT"]],
    });
    const reviewer = await createSoftwareSigningProvider({
      keyType: "EC",
      subject: [["CN", "REVIEWER"], ["C", "PT"]],
    });

    const [first] = await signFiles([{ name: "model.ifc", bytes: MODEL }], author);

    // The reviewer signs the same payload; their signature joins the container.
    const [second] = await signFiles([{ name: "model.ifc", bytes: MODEL }], reviewer);
    const secondXml = new TextDecoder().decode(
      unzipSync(second.bytes)["META-INF/signatures001.xml"],
    );
    const inner = secondXml.replace(/^[\s\S]*?(<ds:Signature)/, "$1").replace(/<\/asic:XAdESSignatures>$/, "");

    const combined = addSignature(first.bytes, inner);
    const result = await verifyContainer(combined);

    expect(listSignatureFiles(unzipSync(combined))).toEqual([
      "META-INF/signatures001.xml",
      "META-INF/signatures002.xml",
    ]);
    expect(result.signatures).toHaveLength(2);
    expect(result.signatures.every((signature) => signature.valid)).toBe(true);

    const subjects = result.signatures.map((signature) => signature.subject);
    expect(subjects.some((s) => s.includes("AUTHOR"))).toBe(true);
    expect(subjects.some((s) => s.includes("REVIEWER"))).toBe(true);
  });
});

describe("container shape", () => {
  it("stays a readable ZIP with the payload at its original name", async () => {
    const [output] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      await createSoftwareSigningProvider(),
    );
    const entries = unzipSync(output.bytes);

    // Any other tool must still find the model where it expects it.
    expect(Object.keys(entries)).toContain("model.ifc");
    expect(Object.keys(entries)).toContain("META-INF/manifest.xml");
    expect(Object.keys(entries)).toContain("META-INF/signatures001.xml");
  });

  it("declares the ASiC-E mimetype", async () => {
    const [output] = await signFiles(
      [{ name: "model.ifc", bytes: MODEL }],
      await createSoftwareSigningProvider(),
    );

    expect(new TextDecoder().decode(unzipSync(output.bytes)["mimetype"])).toBe(
      "application/vnd.etsi.asic-e+zip",
    );
  });

  it("names an IFC container .ifczip and keeps a BCF one .bcf", async () => {
    const device = await createSoftwareSigningProvider();

    const [ifc] = await signFiles([{ name: "model.ifc", bytes: MODEL }], device, {
      mode: "per-file",
      kind: "ifc",
    });
    const [bcf] = await signFiles([{ name: "issues.bcf", bytes: BCF }], device, {
      mode: "per-file",
      kind: "bcf",
    });

    expect(ifc.name).toBe("model.ifczip");
    expect(bcf.name).toBe("issues.bcf");
  });

  it("signs a BCF by adding META-INF, not by nesting the zip inside a zip", async () => {
    const [output] = await signFiles([{ name: "issues.bcf", bytes: BCF }], await createSoftwareSigningProvider(), {
      mode: "per-file",
      kind: "bcf",
    });
    const entries = unzipSync(output.bytes);

    // The BCF's own entries sit at the container's top level, exactly as they
    // did in the unsigned file — a BCF reader that knows nothing about
    // signatures still finds them.
    expect(Object.keys(entries)).toContain("bcf.version");
    expect(Object.keys(entries)).toContain(`${TOPIC_GUID}/markup.bcf`);
    expect(Object.keys(entries)).toContain("META-INF/manifest.xml");
    // Not present: the whole original file nested as one opaque entry.
    expect(Object.keys(entries)).not.toContain("issues.bcf");
  });

  it("reports a container with no signature rather than throwing", async () => {
    const { zipSync } = await import("fflate");
    const result = await verifyContainer(
      zipSync({ "model.ifc": MODEL }),
    );

    expect(result.problems).toEqual(["This container carries no signature."]);
    expect(result.payload).toEqual(["model.ifc"]);
  });

  it("reports a file that is not a ZIP rather than throwing", async () => {
    const result = await verifyContainer(new TextEncoder().encode("not a zip"));
    expect(result.problems[0]).toMatch(/not a readable ZIP/);
  });
});

describe("certificates", () => {
  it("round-trips subject, serial and validity through DER", async () => {
    const device = await createSoftwareSigningProvider({
      subject: [["CN", "MARIA EXEMPLO"], ["C", "PT"]],
    });
    const certificate = await device.getSigningCertificate();
    const parsed = readCertificate(fromBase64(certificate.certificateDer));

    expect(parsed.subject).toContain("CN=MARIA EXEMPLO");
    expect(parsed.subject).toContain("C=PT");
    expect(parsed.keyType).toBe("RSA");
    expect(parsed.notBefore).toBe("2020-01-01T00:00:00Z");
  });

  it("reads an EC certificate as EC", async () => {
    const device = await createSoftwareSigningProvider({ keyType: "EC" });
    const certificate = await device.getSigningCertificate();

    expect(readCertificate(fromBase64(certificate.certificateDer)).keyType).toBe("EC");
  });
});

describe("device guards", () => {
  it("refuses to sign for a different certificate than was prepared", async () => {
    const device = await createSoftwareSigningProvider();

    await expect(
      device.sign({
        dataToBeSigned: new TextEncoder().encode("x"),
        hash: "SHA-256",
        expectCertificateDer: "a-different-certificate",
      }),
    ).rejects.toThrow(/certificate changed/i);
  });
});

describe("createContainer", () => {
  it("puts mimetype first, which ASiC requires", async () => {
    const container = createContainer(
      [{ name: "model.ifc", bytes: MODEL, mimeType: "application/x-step" }],
      "<ds:Signature xmlns:ds='x'></ds:Signature>",
    );

    // The local file header for the first entry starts at offset 30 + name.
    const head = new TextDecoder().decode(container.subarray(0, 64));
    expect(head).toContain("mimetype");
  });
});
