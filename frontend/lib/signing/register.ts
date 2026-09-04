"use client";

/**
 * Wire the signing providers up.
 *
 * Lazy, so a production bundle never ships the software or mock devices and a
 * test run never loads the Web eID protocol code. Import this once, from the
 * signing pages.
 */

import { registerSigningProvider } from "./provider";

let registered = false;

export function registerSigningProviders() {
  if (registered) return;
  registered = true;

  registerSigningProvider("companion", async () => {
    const { createCompanionSigningProvider } = await import("./providers/companion");
    return createCompanionSigningProvider();
  });

  registerSigningProvider("webeid", async () => {
    const { createWebEidSigningProvider } = await import("./providers/webeid");
    return createWebEidSigningProvider();
  });

  registerSigningProvider("software", async () => {
    const { createSoftwareSigningProvider } = await import("./providers/software");
    return createSoftwareSigningProvider();
  });

  registerSigningProvider("mock", async () => {
    const { createMockSigningProvider } = await import("./providers/mock");
    return createMockSigningProvider();
  });

  // `softhsm` is intentionally absent: ADR 004 scopes it to CI driving the real
  // native host, which does not exist yet. Registering a stub that cannot sign
  // would only produce a confusing failure at the PIN step.
}
