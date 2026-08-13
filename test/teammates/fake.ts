/**
 * A scripted stand-in for a teammate's `AgentSession`.
 *
 * The whole point of `TeammateSpawner` being a seam is that the delivery obligation can be tested
 * against the behaviours that actually happened — "finished the work and said nothing", "delivered
 * only after being reminded twice", "delivered after being released" — without opening a model
 * session. Each element of `script` is what the child does on one `prompt()`.
 *
 * `deliver` is supplied by the caller rather than hard-wired to the registry so the same fake can be
 * driven through the injected `reply_to_lead` tool in the end-to-end test, which is the path a real
 * child takes.
 */
import type { DeliverySink, TeammateSession } from "../../extensions/teammates/runtime.ts";

export type Turn =
  | { readonly act: "silent" }
  | { readonly act: "deliver"; readonly report: string; readonly status?: "complete" | "blocked" }
  | { readonly act: "throw"; readonly message: string };

export type Deliver = (report: string, status: "complete" | "blocked") => void | Promise<void>;

export class FakeSession implements TeammateSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly prompts: string[] = [];
  disposed = 0;

  #script: Turn[];
  #last: Turn = { act: "silent" };
  #deliver: Deliver;
  #name: string;

  constructor(name: string, deliver: Deliver, script: Turn[], sessionFile = `/tmp-fake/${name}.jsonl`) {
    this.#name = name;
    this.#deliver = deliver;
    this.#script = [...script];
    this.sessionId = `fake-${name}`;
    this.sessionFile = sessionFile;
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    const turn = this.#script.shift() ?? { act: "silent" };
    this.#last = turn;
    if (turn.act === "throw") throw new Error(turn.message);
    if (turn.act === "deliver") await this.#deliver(turn.report, turn.status ?? "complete");
  }

  lastAssistantText(): string | undefined {
    return this.#last.act === "deliver" ? this.#last.report : `working notes from ${this.#name}`;
  }

  dispose(): void {
    this.disposed += 1;
  }
}

/** The direct path: deliver straight into the registry, bypassing the injected tool. */
export function sinkDeliver(sink: DeliverySink, name: string): Deliver {
  return (report, status) => void sink.deliver(name, report, status);
}
