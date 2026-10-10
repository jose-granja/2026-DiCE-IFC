// @vitest-environment jsdom

/**
 * A signed BCF is still a BCF.
 *
 * ADR 002's container choice means a signed issue set is the same zip with
 * `META-INF/` added, so an ordinary reader opens it unchanged and the signature
 * is an extra fact about where the issues came from — not a different format.
 * That property is easy to break and invisible when it is, so it is asserted
 * here rather than assumed.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { signFiles } from "@/lib/signing/sign";
import { createSoftwareSigningProvider } from "@/lib/signing/providers/software";
import { summariseSignature } from "@/lib/signing/summary";
import { parseBcf } from "../parse";

const UNSIGNED = new Uint8Array(
  readFileSync(
    path.resolve(import.meta.dirname, "../../../fixtures/bcf/v3.0/labels.bcf"),
  ),
);

/** The real topic's markup entry, unpacked so tests can name it. */
const MARKUP_PATH = "bee19eb8-3ec0-4e0d-90df-52afc806beaf/markup.bcf";

/** Sign the fixture the way `/sign/bcf` does. */
async function sign(): Promise<Uint8Array> {
  const device = await createSoftwareSigningProvider();
  const [{ bytes }] = await signFiles(
    [{ name: "issues.bcf", bytes: UNSIGNED }],
    device,
    { mode: "per-file", kind: "bcf" },
  );
  return bytes;
}

describe("a signed issue set", () => {
  it("reports no signature for an ordinary BCF", async () => {
    // `undefined`, not "invalid": an unsigned file is the ordinary case and
    // gets no badge.
    expect(await summariseSignature(UNSIGNED, "labels.bcf")).toBeUndefined();
  });

  it("reports a valid signature and who signed it", async () => {
    const signature = await summariseSignature(await sign(), "issues.bcf");

    expect(signature).toBeDefined();
    expect(signature!.valid).toBe(true);
    expect(signature!.signers).toHaveLength(1);
    expect(signature!.signers[0].subject).toContain("SOFTWARE TEST KEY");
    // Integrity is not trust; the chain is not checked until the trust proxy.
    expect(signature!.signers[0].trust).toBe("not-checked");
  });

  it("notices when the issues were changed after signing", async () => {
    const container = await sign();
    const { unzipSync, zipSync } = await import("fflate");

    const entries = unzipSync(container);
    entries[MARKUP_PATH] = new TextEncoder().encode("tampered");

    const signature = await summariseSignature(zipSync(entries), "issues.bcf");
    expect(signature!.valid).toBe(false);
  });

  it("still parses as BCF, because META-INF is just another entry", async () => {
    // The whole point of the container choice: a tool that knows nothing about
    // signatures opens it unchanged — no reaching inside for a nested blob.
    const container = await sign();

    const { file } = parseBcf(container, "issues.bcf");
    expect(file.topics.length).toBeGreaterThan(0);
  });
});
