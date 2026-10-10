"use client";

import { useEffect, useState } from "react";

/**
 * A timestamp that is stable within a render and refreshes periodically.
 *
 * Calling `Date.now()` during render is impure: two renders of the same state
 * can disagree, which is exactly the kind of thing the React Compiler's purity
 * rule exists to catch. Reading it once into state fixes that.
 *
 * The interval is not decoration. "Overdue" is the one piece of derived state
 * here that changes with no user action at all, and a coordination tab left
 * open overnight would otherwise still show yesterday's answer.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}

export default useNow;
