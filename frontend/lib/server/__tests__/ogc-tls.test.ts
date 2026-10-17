import { X509Certificate } from "node:crypto";
import * as tls from "node:tls";
import { describe, expect, it } from "vitest";
import { ogcTlsOptions } from "../ogc-tls";

describe("OGC certificate chain completion", () => {
  it("adds the published Sectigo intermediate to Gaia's existing trust store", () => {
    const options = ogcTlsOptions("opendata.gaiurb.pt");
    const ca = options.ca as string[];
    const defaults = typeof tls.getCACertificates === "function"
      ? tls.getCACertificates("default") : tls.rootCertificates;
    expect(ca.slice(0, -1)).toEqual(defaults);
    const intermediate = new X509Certificate(ca.at(-1)!);
    expect(intermediate.fingerprint256.replaceAll(":", "")).toBe(
      "8C54C334B66BA4E426772AF4A3F9136C19A1AEC729FDB28C535C07A5A4EF22E0",
    );
    expect(intermediate.ca).toBe(true);
    expect(intermediate.subject).not.toBe(intermediate.issuer);
    const issuer = defaults.map((pem) => new X509Certificate(pem))
      .find((cert) => intermediate.checkIssued(cert) && intermediate.verify(cert.publicKey));
    expect(issuer?.subject).toContain("Sectigo Public Server Authentication Root R46");
  });

  it("keeps chain and hostname verification enabled", () => {
    const options = ogcTlsOptions("opendata.gaiurb.pt");
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.allowPartialTrustChain).toBe(false);
    // Node's built-in hostname checker remains in control.
    expect(options.checkServerIdentity).toBeUndefined();
  });

  it.each(["maps.example.org", "gaiurb.pt", "opendata.gaiurb.pt.example.org", "other.gaiurb.pt"])(
    "leaves the default CA selection unchanged for %s", (hostname) => {
      expect(ogcTlsOptions(hostname)).toEqual({ rejectUnauthorized: true, allowPartialTrustChain: false });
    },
  );
});
