// @vitest-environment jsdom

/**
 * A container signed by another tool, with a real Cartão de Cidadão.
 *
 * This is the case that mattered and that nothing else covered: every other
 * signing test verifies a signature this application produced, so our writer
 * and our verifier could agree with each other while both being wrong — which
 * is exactly what happened. A file from a different implementation is the only
 * thing that catches it.
 *
 * **The file is not committed.** It carries the citizen's own qualified
 * certificate — name and civil identification number — and that does not belong
 * in a repository. The test reads it from disk when present and skips
 * otherwise, so it is a real check on the machine that has one and never a
 * failure on the machines that do not.
 *
 * Point `DICE_SIGNED_FIXTURE` at any container signed elsewhere to run it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { verifyContainer } from "../verify";

function locate(): string | null {
  const configured = process.env.DICE_SIGNED_FIXTURE;
  if (configured && existsSync(configured)) return configured;

  const downloads = path.join(os.homedir(), "Downloads", "ifcsign");
  if (!existsSync(downloads)) return null;

  // Most recent signing run that produced a container.
  const folders = readdirSync(downloads)
    .map((name) => path.join(downloads, name))
    .filter((entry) => statSync(entry).isDirectory())
    .sort()
    .reverse();

  for (const folder of folders) {
    const container = readdirSync(folder).find((name) => /\.(ifczip|asice)$/i.test(name));
    if (container) return path.join(folder, container);
  }
  return null;
}

const file = locate();

describe.skipIf(!file)("a real Cartão de Cidadão signature", () => {
  it("verifies", async () => {
    const result = await verifyContainer(new Uint8Array(readFileSync(file!)));

    expect(result.problems).toEqual([]);
    expect(result.signatures).toHaveLength(1);

    const [signature] = result.signatures;
    // The signature over the canonicalised SignedInfo.
    expect(signature.signatureValid).toBe(true);
    // Both references: the payload, and the signed properties.
    expect(signature.references.every((r) => r.present && r.digestMatches)).toBe(true);
    expect(signature.valid).toBe(true);
  });

  it("reads the certificate the card issued", async () => {
    const result = await verifyContainer(new Uint8Array(readFileSync(file!)));
    const [signature] = result.signatures;

    expect(signature.issuer).toContain("Cart");
    expect(signature.algorithm).toMatch(/^(RSA|ECDSA)-SHA-(256|384|512)$/);
    expect(signature.serial).toMatch(/^[0-9A-F]+$/);
  });

  it("still refuses to call it trusted", async () => {
    // Valid is not trusted. Chain and revocation need the `trust/` proxy.
    const result = await verifyContainer(new Uint8Array(readFileSync(file!)));
    expect(result.signatures[0].trust).toBe("not-checked");
  });
});
