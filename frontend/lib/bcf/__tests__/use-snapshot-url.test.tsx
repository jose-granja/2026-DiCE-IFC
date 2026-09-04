// @vitest-environment jsdom

import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSnapshotUrl } from "../use-snapshot-url";
import type { BcfViewpoint } from "../types";

/**
 * The blob URL behind a BCF snapshot.
 *
 * This exists because of a real failure: `net::ERR_FILE_NOT_FOUND` on every
 * snapshot in development. The URL was created in a `useMemo` and revoked in an
 * effect's cleanup, which looks equivalent to creating and revoking in one
 * effect and is not — React deliberately runs effects twice in development
 * (setup, cleanup, setup), so the cleanup revoked the URL while the memo, its
 * dependencies unchanged, kept handing back the dead one.
 *
 * So the test mounts under `StrictMode`, which is exactly that double-invoke,
 * and asserts the URL handed out is one that was never revoked.
 */

const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;

  let counter = 0;
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: () => {
      const url = `blob:test/${(counter += 1)}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function viewpoint(bytes: Uint8Array | undefined): BcfViewpoint {
  return {
    guid: "v1",
    snapshot: bytes ? { fileName: "s.png", bytes } : undefined,
    viewpointFile: "v.bcfv",
    components: undefined,
    camera: undefined,
  } as unknown as BcfViewpoint;
}

/** Mount a component that reports whatever the hook returns. */
function mount(bytes: Uint8Array | undefined, strict: boolean) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const seen: Array<string | null> = [];

  function Probe() {
    const url = useSnapshotUrl(viewpoint(bytes));
    useEffect(() => {
      seen.push(url);
    }, [url]);
    return null;
  }

  act(() => {
    root.render(strict ? <StrictMode><Probe /></StrictMode> : <Probe />);
  });

  return { root, container, seen, last: () => seen[seen.length - 1] ?? null };
}

describe("useSnapshotUrl", () => {
  it("hands back a live URL under StrictMode's double-invoked effects", () => {
    const { last, root } = mount(new Uint8Array([1, 2, 3]), true);

    const url = last();
    expect(url).toBeTruthy();
    // The whole bug: the URL that is rendered must not be one already released.
    expect(revoked).not.toContain(url);

    act(() => root.unmount());
  });

  it("releases every URL it created, once the component is gone", () => {
    const { root } = mount(new Uint8Array([1, 2, 3]), true);
    act(() => root.unmount());

    // No leak: a coordination file can carry hundreds of viewpoints.
    expect(new Set(revoked)).toEqual(new Set(created));
  });

  it("creates nothing when the viewpoint has no snapshot", () => {
    const { last, root } = mount(undefined, true);
    expect(last()).toBeNull();
    expect(created).toHaveLength(0);
    act(() => root.unmount());
  });

  it("creates nothing for an empty snapshot", () => {
    const { last, root } = mount(new Uint8Array(), true);
    expect(last()).toBeNull();
    expect(created).toHaveLength(0);
    act(() => root.unmount());
  });

  it("behaves the same without StrictMode", () => {
    const { last, root } = mount(new Uint8Array([9]), false);
    expect(last()).toBeTruthy();
    expect(revoked).not.toContain(last());
    act(() => root.unmount());
  });
});
