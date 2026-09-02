/**
 * EXT-32 — the control lane's handler registry.
 *
 * A `kind !== "message"` envelope is never handed to `pi.sendMessage()` — that would start an LLM
 * turn for something that is not a chat message. Instead `index.ts`'s `drain()` looks up a handler
 * for the envelope's `kind` here and calls it directly. This file only owns the lookup; it does not
 * know what any `kind` means. `extensions/compaction/peer.ts` is the one caller that registers
 * something today (`"compact"`), but nothing here is compaction-specific.
 *
 * Mirrors `dispatch/isolation.ts`'s `registerWorktreeProvider` idiom — last registration for a key
 * wins, re-registering is reported back to the caller rather than silently swallowed — with a `Map`
 * instead of a single slot, because more than one `kind` can be claimed at once.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Envelope } from "./directory.ts";

export interface ControlEnvelope {
  readonly id: string;
  readonly from: string;
  readonly fromSessionId: string;
  readonly at: number;
  readonly instructions?: string;
}

export type ControlOutcome = "ok" | "deferred" | "refused";

export interface ControlHandlerResult {
  readonly outcome: ControlOutcome;
  readonly detail?: string;
}

export interface ControlContext {
  readonly pi: ExtensionAPI;
  readonly selfName: string;
  readonly selfSessionId: string;
}

export type ControlHandler = (
  envelope: ControlEnvelope,
  ctx: ExtensionContext,
  control: ControlContext,
) => Promise<ControlHandlerResult> | ControlHandlerResult;

const handlers = new Map<string, ControlHandler>();

export function registerControlHandler(kind: string, handler: ControlHandler): { readonly replaced: boolean } {
  const replaced = handlers.has(kind);
  handlers.set(kind, handler);
  return { replaced };
}

export function controlHandler(kind: string): ControlHandler | undefined {
  return handlers.get(kind);
}

export function __resetControlHandlersForTests(): void {
  handlers.clear();
}

export function toControlEnvelope(envelope: Envelope): ControlEnvelope {
  return {
    id: envelope.id,
    from: envelope.from,
    fromSessionId: envelope.fromSessionId,
    at: envelope.at,
    ...(envelope.instructions !== undefined ? { instructions: envelope.instructions } : {}),
  };
}
