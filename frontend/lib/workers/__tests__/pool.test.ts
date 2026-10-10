import { describe, expect, it } from "vitest";

import { WorkerPool } from "../pool";

/** Enough of a Worker for Comlink to wrap and for the pool to terminate. */
function fakeWorker(): Worker {
  return {
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    terminate() {},
  } as unknown as Worker;
}

describe("WorkerPool leases", () => {
  it("holds more models than it has workers, without waiting", async () => {
    const pool = new WorkerPool<object>(fakeWorker, { size: 4 });

    // Twelve models into four workers: the old pool reserved a worker per model,
    // so the fifth lease would never have resolved.
    const leases = await Promise.race([
      Promise.all(Array.from({ length: 12 }, () => pool.lease())),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("a lease waited")), 500)),
    ]);

    expect(leases).toHaveLength(12);
    expect(pool.residents).toEqual([3, 3, 3, 3]);
    pool.terminate();
  });

  it("spreads models evenly, and puts the next one where a model was closed", async () => {
    const pool = new WorkerPool<object>(fakeWorker, { size: 2 });
    const [first, second, third] = await Promise.all([pool.lease(), pool.lease(), pool.lease()]);
    expect(pool.residents).toEqual([2, 1]);

    first.release();
    expect(pool.residents).toEqual([1, 1]);
    const fourth = await pool.lease();
    expect(pool.residents.reduce((a, b) => a + b)).toBe(3);

    // Releasing twice must not drive the count negative.
    second.release();
    second.release();
    expect(Math.min(...pool.residents)).toBeGreaterThanOrEqual(0);
    void third;
    void fourth;
    pool.terminate();
  });

  it("refuses a lease once terminated", async () => {
    const pool = new WorkerPool<object>(fakeWorker, { size: 1 });
    pool.terminate();
    await expect(pool.lease()).rejects.toThrow(/terminated/);
  });
});
