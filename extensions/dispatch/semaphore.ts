/**
 * **VP-02** — the per-provider concurrency primitive. Queue, never error.
 *
 * An earlier draft's `Semaphore` over-subscribes. Its release path is
 *
 *     finally { this.active--; this.queue.shift()?.(); }
 *
 * and its acquire path is `if (active >= limit) await new Promise(r => queue.push(r)); active++`.
 * Resolving a waiter's promise does not run the waiter — that happens a microtask later. In the
 * window between the release and the waiter's `active++`, a brand-new `run()` observes
 * `active === limit - 1`, passes the check synchronously, and increments. The woken waiter then
 * increments again: `limit + 1` tasks in flight. On a lane capped at 1 — a gateway whose operator
 * allows exactly one request in flight — that is two children where one was permitted.
 *
 * The fix is to **transfer the permit** rather than to release it and let the next caller re-test:
 * the count is decremented only when there is nobody waiting, and a woken waiter inherits the
 * permit that was never given back. `test/dispatch/semaphore.test.ts` drives the exact interleaving
 * the spec's version fails.
 */

export type Release = () => void;

export class ProviderSemaphore {
  #active = 0;
  readonly #waiters: Array<() => void> = [];
  readonly limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`ProviderSemaphore limit must be a positive integer, got ${String(limit)}`);
    }
    this.limit = limit;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  /** Resolves when a permit is held. The returned release is idempotent. */
  acquire(): Promise<Release> {
    if (this.#active < this.limit) {
      this.#active++;
      return Promise.resolve(this.#makeRelease());
    }
    return new Promise<Release>((resolve) => {
      // The permit is handed over already held: `#active` is not decremented on the release path
      // when a waiter exists, so there is no window in which a newcomer can claim it first.
      this.#waiters.push(() => resolve(this.#makeRelease()));
    });
  }

  /** FIFO. A task that throws still releases its permit. */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  #makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) {
        // Permit transferred: the count stays where it is.
        next();
        return;
      }
      this.#active--;
    };
  }
}

/**
 * One semaphore per provider key, created on first use from the `concurrency` map in
 * `config/routing.json`. A provider with no entry gets `defaultLimit`.
 */
export class ProviderSemaphoreSet {
  readonly #byProvider = new Map<string, ProviderSemaphore>();
  readonly #limits: Readonly<Record<string, number>>;
  readonly #defaultLimit: number;

  constructor(limits: Readonly<Record<string, number>>, defaultLimit: number) {
    if (!Number.isInteger(defaultLimit) || defaultLimit < 1) {
      throw new RangeError(`default concurrency must be a positive integer, got ${String(defaultLimit)}`);
    }
    this.#limits = limits;
    this.#defaultLimit = defaultLimit;
  }

  limitFor(provider: string): number {
    const configured = this.#limits[provider];
    return typeof configured === "number" && Number.isInteger(configured) && configured >= 1
      ? configured
      : this.#defaultLimit;
  }

  for(provider: string): ProviderSemaphore {
    const existing = this.#byProvider.get(provider);
    if (existing) return existing;
    const created = new ProviderSemaphore(this.limitFor(provider));
    this.#byProvider.set(provider, created);
    return created;
  }

  run<T>(provider: string, fn: () => Promise<T> | T): Promise<T> {
    return this.for(provider).run(fn);
  }

  /** For `/agents` and `/doctor`: what is running and what is queued, per provider. */
  snapshot(): Array<{ provider: string; limit: number; active: number; waiting: number }> {
    return [...this.#byProvider.entries()]
      .map(([provider, sem]) => ({ provider, limit: sem.limit, active: sem.active, waiting: sem.waiting }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }
}
