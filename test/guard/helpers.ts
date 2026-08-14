import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { guardedHandler, type GuardRule } from "../../extensions/lib/guarded-handler.ts";
import { buildRules } from "../../extensions/guard.ts";
import { DEFAULT_POLICY, type Policy } from "../../extensions/guard/policy.ts";
import { defaultServices, type GuardServices } from "../../extensions/guard/services.ts";

/** A cwd that cannot accidentally match a secret-path pattern, so the tests are hermetic. */
export const TEST_CWD = "/workspace/project";

export interface Recorder {
  readonly audit: Array<[string, unknown]>;
  readonly log: string[];
  readonly selected: string[][];
  readonly confirmed: string[];
  readonly services: GuardServices;
}

export function recorder(): Recorder {
  const audit: Array<[string, unknown]> = [];
  const log: string[] = [];
  const services = defaultServices({
    audit: (type, data) => void audit.push([type, data]),
    log: (line) => void log.push(line),
  });
  return { audit, log, selected: [], confirmed: [], services };
}

export interface FakeUiOptions {
  readonly hasUI?: boolean;
  readonly mode?: "tui" | "rpc" | "json" | "print";
  readonly cwd?: string;
  /** What `ctx.ui.select` returns. `undefined` models a dismissed or timed-out dialog. */
  readonly select?: (title: string, options: string[]) => string | undefined;
  readonly confirm?: (title: string, message: string) => boolean;
}

export function fakeCtx(opts: FakeUiOptions = {}, rec?: Recorder): ExtensionContext {
  const hasUI = opts.hasUI ?? true;
  return {
    hasUI,
    mode: opts.mode ?? (hasUI ? "tui" : "print"),
    cwd: opts.cwd ?? TEST_CWD,
    ui: {
      async select(title: string, options: string[]) {
        rec?.selected.push(options);
        return opts.select ? opts.select(title, options) : options[0];
      },
      async confirm(title: string, message: string) {
        rec?.confirmed.push(message);
        return opts.confirm ? opts.confirm(title, message) : true;
      },
      notify() {},
    },
  } as unknown as ExtensionContext;
}

export function bashEvent(command: string, toolCallId = "tc-1"): ToolCallEvent {
  return { type: "tool_call", toolCallId, toolName: "bash", input: { command } } as ToolCallEvent;
}

export function readEvent(path: string): ToolCallEvent {
  return { type: "tool_call", toolCallId: "tc-r", toolName: "read", input: { path } } as ToolCallEvent;
}

export function customEvent(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = "tc-c",
): ToolCallEvent {
  return { type: "tool_call", toolCallId, toolName, input } as ToolCallEvent;
}

/** The shipped policy, minus the `degraded` flag the built-in defaults carry. */
export function testPolicy(overrides: Partial<Policy> = {}): Policy {
  return { ...DEFAULT_POLICY, degraded: false, source: "<test>", ...overrides };
}

/**
 * The composed rule set.
 *
 * This used to filter out `ALW`, the interactive allow-list gate, so the ported harness could run
 * the way `test-block-dangerous-bash.sh` did — with no approval prompt in the way. That gate was
 * removed in the 2026-08-14 deny-list inversion, so there is no longer anything to filter: the
 * full set is the safety set, and nothing in it can block on a human.
 */
export function safetyRules(policy: Policy, services: GuardServices): GuardRule[] {
  return buildRules(policy, services);
}

export interface Verdict {
  readonly blocked: boolean;
  readonly gateId?: string;
  readonly reason?: string;
}

const GATE_ID = /^Blocked by gate ([A-Z0-9-]+):/;

export async function runRules(
  rules: GuardRule[],
  event: ToolCallEvent,
  ctx: ExtensionContext,
  services: GuardServices,
): Promise<Verdict> {
  const result = await guardedHandler({
    owner: "guard",
    rules,
    // Mirrors `guard.ts`'s real registration (F2): a repeating internal error must keep
    // surfacing, not go silent after the first `surfaceOnce` dedup.
    alwaysSurfaceInternalErrors: true,
    audit: services.audit,
    log: services.log,
  })(event, ctx);
  if (!result?.block) return { blocked: false };
  const reason = result.reason ?? "";
  return { blocked: true, gateId: GATE_ID.exec(reason)?.[1], reason };
}
