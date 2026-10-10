"use client";

/**
 * A tiny worker pool.
 *
 * Loading a federation means parsing N files, and one worker would serialise
 * them. This runs up to `size` workers and spreads work across them.
 *
 * Two different things are handed out, and they must not be confused:
 *
 * - `run` is a *task*: it needs a free worker for its duration and queues when
 *   they are all busy.
 * - `lease` is *residency*: a loaded model lives in a worker for as long as the
 *   file is open, which can be the whole session. It never waits. It goes to the
 *   worker holding the fewest, so a federation of twelve models is three per
 *   worker rather than four models and eight files stuck behind them. (It used
 *   to reserve a worker exclusively, which capped the viewer at `size` models
 *   and left the fifth silently "parsing" until one was closed.)
 *
 * Deliberately not a generic job queue: tasks are opaque functions that receive
 * a Comlink proxy, so the pool knows nothing about IFC and the worker API stays
 * the single source of truth for what a worker can do.
 */

import * as Comlink from "comlink";

export type WorkerFactory = () => Worker;

type Slot<TApi> = {
  worker: Worker;
  api: Comlink.Remote<TApi>;
  /** Tasks currently in flight on this worker. */
  inFlight: number;
  /** Models (or anything else leased) currently living in this worker. */
  resident: number;
};

export type PoolOptions = {
  /**
   * Defaults to `hardwareConcurrency - 1`, clamped to 1–4. More than four
   * WASM parsers on a laptop competes for memory bandwidth and makes every
   * model slower, not just the extra ones.
   */
  size?: number;
  /** How many tasks one worker may run concurrently. 1 for CPU-bound parsing. */
  concurrencyPerWorker?: number;
};

export class WorkerPool<TApi> {
  private readonly slots: Slot<TApi>[] = [];
  private readonly queue: Array<() => void> = [];
  private readonly concurrencyPerWorker: number;
  private disposed = false;

  constructor(
    private readonly factory: WorkerFactory,
    options: PoolOptions = {},
  ) {
    const hardware =
      typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
    const size = options.size ?? Math.min(4, Math.max(1, hardware - 1));
    this.concurrencyPerWorker = options.concurrencyPerWorker ?? 1;

    for (let i = 0; i < size; i += 1) {
      const worker = this.factory();
      this.slots.push({
        worker,
        api: Comlink.wrap<TApi>(worker),
        inFlight: 0,
        resident: 0,
      });
    }
  }

  get size(): number {
    return this.slots.length;
  }

  /** How many leases each worker holds — for tests and diagnostics. */
  get residents(): number[] {
    return this.slots.map((slot) => slot.resident);
  }

  /**
   * Run `task` on a worker, waiting for a free slot if they are all busy.
   *
   * The proxy handed to `task` belongs to one specific worker, so a caller that
   * needs several operations against the same loaded model must do them inside
   * a single `run` — a `ModelId` from one worker means nothing to another.
   */
  async run<T>(task: (api: Comlink.Remote<TApi>) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("WorkerPool has been terminated");

    const slot = await this.acquire();
    slot.inFlight += 1;
    try {
      return await task(slot.api);
    } finally {
      slot.inFlight -= 1;
      this.release();
    }
  }

  /**
   * Pin work to one worker for a sequence of calls — the normal case for a
   * loaded model. Returns the proxy and a release function.
   *
   * Does not wait: the worker with the fewest residents takes it. Memory, not
   * the worker count, is what limits how many models can be open, and spreading
   * them keeps any one worker's WebAssembly heap (4 GB at most) from filling
   * while others sit empty.
   */
  async lease(): Promise<{
    api: Comlink.Remote<TApi>;
    release: () => void;
  }> {
    if (this.disposed) throw new Error("WorkerPool has been terminated");

    const slot = this.slots.reduce((best, candidate) =>
      candidate.resident < best.resident ? candidate : best,
    );
    slot.resident += 1;

    let released = false;
    return {
      api: slot.api,
      release: () => {
        if (released) return;
        released = true;
        slot.resident -= 1;
      },
    };
  }

  private async acquire(): Promise<Slot<TApi>> {
    const free = () =>
      this.slots.find((s) => s.inFlight < this.concurrencyPerWorker);

    const available = free();
    if (available) return available;

    await new Promise<void>((resolve) => this.queue.push(resolve));
    // The waiter that was just woken has a free slot by construction, but
    // re-check rather than assert: `terminate` also drains the queue.
    const slot = free();
    if (!slot) throw new Error("WorkerPool has been terminated");
    return slot;
  }

  private release() {
    const next = this.queue.shift();
    if (next) next();
  }

  terminate() {
    this.disposed = true;
    for (const slot of this.slots) {
      slot.api[Comlink.releaseProxy]?.();
      slot.worker.terminate();
    }
    this.slots.length = 0;
    // Wake every waiter so their `acquire` throws instead of hanging forever.
    while (this.queue.length) this.queue.shift()!();
  }
}
