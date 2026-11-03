import { describe, expect, it } from "vitest";

import { isSameOrigin } from "../same-origin";

describe("isSameOrigin", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);

  it("accepts a page on the host the request was addressed to", () => {
    expect(isSameOrigin(headers({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }))).toBe(true);
    // Behind nginx: the public name, whatever Next itself listens on.
    expect(isSameOrigin(headers({ host: "frontend:3000", "x-forwarded-host": "dice.example", origin: "https://dice.example" }))).toBe(true);
    // No Origin: not a cross-site request.
    expect(isSameOrigin(headers({ host: "dice.example" }))).toBe(true);
  });

  it("refuses another site, another port, and nonsense", () => {
    expect(isSameOrigin(headers({ host: "dice.example", origin: "https://evil.example" }))).toBe(false);
    expect(isSameOrigin(headers({ host: "dice.example", origin: "https://dice.example:8443" }))).toBe(false);
    expect(isSameOrigin(headers({ host: "dice.example", origin: "null" }))).toBe(false);
    expect(isSameOrigin(headers({ origin: "https://dice.example" }))).toBe(false);
  });
});
