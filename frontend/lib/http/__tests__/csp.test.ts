import { describe, expect, it } from "vitest";

import { workerCsp } from "../csp";

/** `directive → sources`, the way a browser reads the header. */
function parse(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name, sources]),
  );
}

describe("workerCsp", () => {
  const prod = parse(workerCsp({ isDev: false }));

  it("lets a worker connect to this origin only", () => {
    expect(prod.get("connect-src")).toEqual(["'self'", "blob:", "data:"]);
  });

  it("refuses anything it does not list", () => {
    expect(prod.get("default-src")).toEqual(["'none'"]);
  });

  it("runs same-origin chunks and WebAssembly, without eval", () => {
    expect(prod.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  });

  it("has no nonce or 'strict-dynamic', which would make the browser ignore 'self'", () => {
    expect(workerCsp({ isDev: false })).not.toMatch(/nonce-|strict-dynamic/);
  });

  it("lets a worker start blob: workers (fflate's async unzip)", () => {
    expect(prod.get("worker-src")).toEqual(["'self'", "blob:"]);
  });

  it("names none of the origins only the page reaches", () => {
    const csp = workerCsp({ isDev: false });
    for (const pageOnly of ["127.0.0.1", "localhost", "cesium.com", "googleapis.com", "cloudflare.com", "polyhaven", "360into"]) {
      expect(csp).not.toContain(pageOnly);
    }
  });

  it("allows eval under next dev only", () => {
    expect(parse(workerCsp({ isDev: true })).get("script-src")).toContain("'unsafe-eval'");
    expect(prod.has("upgrade-insecure-requests")).toBe(true);
    expect(parse(workerCsp({ isDev: true })).has("upgrade-insecure-requests")).toBe(false);
  });
});
