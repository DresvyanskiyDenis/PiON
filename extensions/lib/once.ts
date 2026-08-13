/**
 * "Surfaced exactly once" (REQ-EXT-16) as a single call site, plus the one error formatter
 * the whole tree shares.
 *
 * Module-level state is deliberate and is safe only because this tree mandates
 * exactly one PI extension file (`extensions/index.ts`). PI loads every discovered extension
 * through its own jiti instance with `moduleCache: false`, so two discovered files would each
 * receive their own copy of this module and the dedup would quietly stop deduping.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const seen = new Set<string>();

/**
 * Emits `emit()` the first time `key` is seen and never again.
 *
 * The emitter is wrapped: this function is called from the fail-open paths of
 * `guarded-handler.ts` and `detach.ts`, whose entire purpose is to not throw. A
 * `ctx.ui.notify` that throws (no UI, closed stream) must not convert a skipped rule into a
 * blocked tool call.
 *
 * @returns true when this call emitted, false when it was deduped.
 */
export function surfaceOnce(
  _ctx: ExtensionContext | undefined,
  key: string,
  emit: () => void,
): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  try {
    emit();
  } catch (err) {
    try {
      process.stderr.write(
        `[pi-config] surfaceOnce(${key}): emitter itself failed: ${describeError(err)}\n`,
      );
    } catch {
      // stderr is gone. There is no third channel; losing the notice beats crashing the host.
    }
  }
  return true;
}

/** Test-only. */
export function resetSurfaced(): void {
  seen.clear();
}

/**
 * Same safety wrapping as `surfaceOnce` — an emitter that throws must not propagate — but always
 * emits, never deduped. For a call site where a repeating internal failure must stay visible on
 * every occurrence (F2: a permanently broken credential gate must never look identical to a
 * healthy one after its first report).
 */
export function surfaceAlways(_ctx: ExtensionContext | undefined, emit: () => void): void {
  try {
    emit();
  } catch (err) {
    try {
      process.stderr.write(
        `[pi-config] surfaceAlways(): emitter itself failed: ${describeError(err)}\n`,
      );
    } catch {
      // stderr is gone. There is no third channel; losing the notice beats crashing the host.
    }
  }
}

/**
 * The error shape every module in this tree reports: error class, message, and the full
 * `cause` chain (REQ-PRV-32 — "fail loud", provider/model context is added by the caller).
 */
export function describeError(err: unknown, maxDepth = 8): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < maxDepth && current !== undefined && current !== null; depth++) {
    parts.push(oneLevel(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  if (parts.length === 0) return String(err);
  return parts.join(" <- caused by ");
}

function oneLevel(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const name = code ? `${err.name}[${code}]` : err.name;
    return `${name}: ${err.message}`;
  }
  if (typeof err === "object") {
    try {
      return JSON.stringify(err) ?? String(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
