import { beforeEach, describe, expect, it } from "vitest";

import { EMPTY_CONVERSION, EMPTY_CRS_FIELDS, hasChanges, useGeorefStore } from "../store";

const placement = (verticalDatum = "") => ({
  epsg: 3763,
  conversion: EMPTY_CONVERSION,
  crs: { ...EMPTY_CRS_FIELDS, verticalDatum },
});

describe("IfcProjectedCRS fields in the draft", () => {
  beforeEach(() => useGeorefStore.getState().reset());

  it("counts a changed vertical datum as an edit", () => {
    expect(hasChanges(placement("EVRF2007"), placement("EVRF2007"))).toBe(false);
    expect(hasChanges(placement(""), placement("Cascais height"))).toBe(true);
    expect(hasChanges(placement("EVRF2007"), placement("EVRF2007 "))).toBe(false);
  });

  it("reads a draft without CRS fields as empty", () => {
    expect(hasChanges({ epsg: 3763, conversion: EMPTY_CONVERSION }, placement(""))).toBe(false);
  });

  it("patches one field and keeps the rest", () => {
    const store = useGeorefStore.getState();
    store.setDraft(placement("NAP"));
    store.patchCrs({ mapZone: "PT-TM06" });
    expect(useGeorefStore.getState().draft?.crs).toMatchObject({
      verticalDatum: "NAP",
      mapZone: "PT-TM06",
    });
  });

  it("keeps the vertical datum when the horizontal CRS changes", () => {
    const store = useGeorefStore.getState();
    store.setDraft(placement("NAP"));
    store.setEpsg(25829);
    expect(useGeorefStore.getState().draft?.crs?.verticalDatum).toBe("NAP");
  });
});

describe("IfcSite location in the draft", () => {
  beforeEach(() => useGeorefStore.getState().reset());

  const withSite = (site: { latitude: number | null; longitude: number | null; elevation: number | null }) => ({
    epsg: 3763,
    conversion: EMPTY_CONVERSION,
    site,
  });

  it("counts a changed latitude, longitude or elevation as an edit", () => {
    const base = { latitude: 41.5, longitude: -8.4, elevation: 190 };
    expect(hasChanges(withSite(base), withSite({ ...base }))).toBe(false);
    expect(hasChanges(withSite(base), withSite({ ...base, latitude: 41.6 }))).toBe(true);
    expect(hasChanges(withSite(base), withSite({ ...base, longitude: -8.5 }))).toBe(true);
    expect(hasChanges(withSite(base), withSite({ ...base, elevation: 191 }))).toBe(true);
  });

  it("reads a draft with no site as empty, and patches one field", () => {
    expect(hasChanges({ epsg: 3763, conversion: EMPTY_CONVERSION }, withSite({ latitude: null, longitude: null, elevation: null }))).toBe(false);
    const store = useGeorefStore.getState();
    store.setDraft(withSite({ latitude: 1, longitude: 2, elevation: 3 }));
    store.patchSite({ elevation: 9 });
    expect(useGeorefStore.getState().draft?.site).toEqual({ latitude: 1, longitude: 2, elevation: 9 });
  });
});
