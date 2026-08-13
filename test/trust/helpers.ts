import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A scratch dir under `$TMPDIR`, never `/tmp` directly. */
export function scratch(): string {
  return mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pi-trust-"));
}

/** Writes a `trusted-roots.json` into a fresh scratch dir and returns its path. */
export function writeRootsFile(body: unknown): string {
  const file = join(scratch(), "trusted-roots.json");
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return file;
}

export interface FakePi {
  readonly api: ExtensionAPI;
  /** PI event handlers, by event name, in registration order. */
  readonly handlers: Map<string, Array<(...args: never[]) => unknown>>;
  /** `pi.events.on` subscriptions, by channel. */
  readonly busListeners: Map<string, Array<(data: unknown) => void>>;
  /** `pi.events.emit` calls, in order. */
  readonly busEmits: Array<[string, unknown]>;
  /** `pi.appendEntry` calls, in order. */
  readonly entries: Array<[string, unknown]>;
}

export function fakePi(): FakePi {
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
  const busListeners = new Map<string, Array<(data: unknown) => void>>();
  const busEmits: Array<[string, unknown]> = [];
  const entries: Array<[string, unknown]> = [];

  const api = {
    on(event: string, handler: (...args: never[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry(type: string, data: unknown) {
      entries.push([type, data]);
    },
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        const list = busListeners.get(channel) ?? [];
        list.push(handler);
        busListeners.set(channel, list);
        return () => undefined;
      },
      emit(channel: string, data: unknown) {
        busEmits.push([channel, data]);
        for (const listener of busListeners.get(channel) ?? []) listener(data);
      },
    },
  } as unknown as ExtensionAPI;

  return { api, handlers, busListeners, busEmits, entries };
}

export interface FakeCtxRecorder {
  readonly notified: Array<[string, string | undefined]>;
  readonly statuses: Array<[string, string | undefined]>;
}

/**
 * `projectTrusted` is what PI itself says — the default `false` matches the default `cwd`, which
 * is outside every declared root, so the MCP trust reconciliation finds no divergence unless a
 * test deliberately creates one.
 */
export function fakeCtx(
  rec: FakeCtxRecorder,
  cwd = "/workspace/project",
  projectTrusted = false,
): ExtensionContext {
  return {
    hasUI: true,
    mode: "tui",
    cwd,
    isProjectTrusted: () => projectTrusted,
    ui: {
      notify(message: string, type?: string) {
        rec.notified.push([message, type]);
      },
      setStatus(key: string, text: string | undefined) {
        rec.statuses.push([key, text]);
      },
    },
  } as unknown as ExtensionContext;
}

export function recorder(): FakeCtxRecorder {
  return { notified: [], statuses: [] };
}

export function toolEvent(toolName: string): ToolCallEvent {
  return { type: "tool_call", toolCallId: "tc-1", toolName, input: {} } as ToolCallEvent;
}
