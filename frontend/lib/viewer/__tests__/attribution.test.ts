import { describe, expect, it } from "vitest";

import { linkAttribution } from "../attribution";

describe("linkAttribution", () => {
  it("links the OpenStreetMap credit to its licence page", () => {
    const parts = linkAttribution("© Cesium ion · © OpenStreetMap contributors");
    expect(parts).toEqual([
      { text: "© Cesium ion", href: "https://cesium.com/legal/terms-of-service/" },
      { text: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" },
    ]);
  });

  it("splits two credits that share one segment, and links both", () => {
    const parts = linkAttribution("© MapTiler © OpenStreetMap contributors");
    expect(parts.map((part) => part.text)).toEqual(["© MapTiler", "© OpenStreetMap contributors"]);
    expect(parts.every((part) => part.href)).toBe(true);
  });

  it("keeps every word of the line, so nothing a provider requires is dropped", () => {
    const line = "© Cesium ion · terrain via Cesium ion · © MapTiler © OpenStreetMap contributors";
    expect(linkAttribution(line).map((part) => part.text).join(" ")).toBe(
      "© Cesium ion terrain via Cesium ion © MapTiler © OpenStreetMap contributors",
    );
  });

  it("passes through a credit it has never heard of, unlinked", () => {
    expect(linkAttribution("© Someone Else")).toEqual([{ text: "© Someone Else" }]);
  });
});
