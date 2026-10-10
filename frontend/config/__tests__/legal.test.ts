import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { contactHref } from "../legal";

describe("contactHref", () => {
  it("turns an address into a mailto link and leaves a URL alone", () => {
    expect(contactHref("privacy@example.org")).toBe("mailto:privacy@example.org");
    expect(contactHref("https://example.org/contact")).toBe("https://example.org/contact");
  });

  it("makes no link out of something that is neither", () => {
    expect(contactHref("ask at the front desk")).toBeNull();
    expect(contactHref("")).toBeNull();
  });
});

describe("the signature verifier's trust warning", () => {
  it("is not hidden", () => {
    // It was once shipped with a stray `hidden` class, so the page said
    // "signature valid" and never said that valid is not trusted.
    const source = readFileSync(new URL("../../app/(home)/sign/verify/page.tsx", import.meta.url), "utf8");
    const notice = source.slice(source.indexOf("data-trust-notice") - 400, source.indexOf("data-trust-notice") + 60);
    expect(source).toContain("data-trust-notice");
    expect(notice).not.toMatch(/\bhidden\b/);
  });
});
