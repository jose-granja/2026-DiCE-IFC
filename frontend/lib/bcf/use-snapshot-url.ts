"use client";

import { useEffect, useState } from "react";

import type { BcfViewpoint } from "./types";

/**
 * A blob URL for the snapshot bytes, released when it is no longer shown.
 *
 * A data URL would be simpler, but base64 inflates every PNG by a third and a
 * coordination file carries hundreds of them.
 *
 * Creation and revocation are **paired inside one effect**, which is the whole
 * point of the shape below. Creating the URL in a `useMemo` and revoking it in
 * an effect's cleanup looks equivalent and is not: React runs effects twice in
 * development — setup, cleanup, setup — so the cleanup revoked the URL while
 * the memo, its dependencies unchanged, kept handing back the dead one. The
 * result was `net::ERR_FILE_NOT_FOUND` on every snapshot.
 *
 * It is also wrong in principle. A memo is a cache React may discard and
 * recompute at will; a blob URL is a resource with an owner and a lifetime,
 * and those are effects.
 *
 * `react-hooks/set-state-in-effect` is suppressed rather than worked around.
 * The rule guards against state derived from other state, which cascades
 * renders; this is the case its own message carves out — state that mirrors an
 * external resource, set when that resource is created. The alternatives are
 * worse: revoking on the image's `load` breaks if React ever recreates the
 * element (list reordering does), and not revoking leaks a URL per viewpoint in
 * a file that can carry hundreds.
 */
export function useSnapshotUrl(viewpoint: BcfViewpoint): string | null {
  const bytes = viewpoint.snapshot?.bytes;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!bytes || bytes.length === 0) return;

    const created = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: "image/png" }),
    );
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    setUrl(created);

    return () => {
      URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [bytes]);

  return url;
}
