/**
 * EXT-32 — `message_agent`: peer-to-peer messaging between PiON sessions.
 *
 * What already existed and is *not* rebuilt here:
 *
 *   - `pi.sendMessage()` is the transport into a session's own turn loop. `EXT-05` wakes a lead for a
 *     finished subagent with it, `EXT-24` for a finished job, `EXT-22` for a stale task. It is
 *     in-process by construction — a handle on *this* session — so it delivers the last hop and
 *     nothing before it.
 *   - `EXT-25` (teammates) addresses children by name through `team.ts`, a map that lives in the
 *     lead's process. A sibling cannot read it; neither can anything that did not do the spawning.
 *
 * The missing middle is therefore the routing, and it is exactly two things: a directory on disk that
 * says which names are live (`directory.ts`), and an inbox per name that any session may write into
 * and only its owner drains. `message_agent` writes an envelope; the owner's poll picks it up and
 * hands it to `pi.sendMessage()`, which is where the packaged machinery takes over and wakes the
 * session. No new transport, no daemon, no socket.
 *
 * Design decisions worth not re-litigating:
 *
 *   - **Fire-and-forget, and symmetric.** `send` returns when the envelope is on disk, never when it
 *     is read. The reply path is the same tool pointed the other way, so there is no third contract
 *     to learn and `reply_to_lead` keeps its single meaning — `EXT-25` is untouched by this module.
 *   - **A poll, not a watcher.** `fs.watch` is per-platform, misses events under load, and would have
 *     to be rebuilt on every rename anyway. One `readdir` of a directory that is almost always empty,
 *     every two seconds, is cheaper than the failure mode it avoids.
 *   - **Always armed.** `EXT-24`'s watcher self-arms because a job that nobody started cannot finish.
 *     A message can arrive at any moment from a session this one has never heard of, so the poll runs
 *     for as long as the registration does. It is `unref()`d and never keeps the process alive.
 */
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { emitNotice } from "../lib/announce.ts";
import { describeError, surfaceOnce } from "../lib/once.ts";
import { logEvent } from "../session-index/index.ts";
import {
  agentsRoot,
  deliver,
  drainInbox,
  ensureAgentsRoot,
  listAgents,
  MessageAgentError,
  registerAgent,
  renderDirectory,
  requireAgent,
  slugifyAgentName,
  unregisterAgent,
  type AgentRecord,
  type Envelope,
} from "./directory.ts";

export const id = "message-agent";

/** The name this session answers to, when the operator wants a stable one. */
export const NAME_ENV = "PI_AGENT_NAME";

export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** Overrides `DEFAULT_POLL_INTERVAL_MS`, in milliseconds. */
export const POLL_INTERVAL_ENV = "PI_AGENT_POLL_MS";

/** Whether an incoming message may start a turn of its own when the session is idle. */
export const DEFAULT_WAKE_ON_IDLE = true;

/** Set to `0` to make an incoming message passive: it renders, but never starts a turn. */
export const WAKE_ENV = "PI_AGENT_WAKE";

/**
 * The poll interval this session uses, in milliseconds.
 *
 * Malformed input throws rather than being read as the default, matching `EXT-24`'s
 * `watchIntervalMs`: a typo that silently restores the default is a session whose operator believes
 * it is polling ten times a second and it is not. The 10ms floor is there because a zero interval is
 * a spin, not a poll.
 */
export function pollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[POLL_INTERVAL_ENV];
  if (raw === undefined) return DEFAULT_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 10) {
    throw new MessageAgentError(
      `${POLL_INTERVAL_ENV} is ${JSON.stringify(raw)}, which is not an integer number of ` +
        `milliseconds >= 10`,
    );
  }
  return parsed;
}

/** Whether an inbound message wakes an idle session. */
export function wakeOnIdle(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[WAKE_ENV];
  if (raw === undefined) return DEFAULT_WAKE_ON_IDLE;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new MessageAgentError(
    `${WAKE_ENV} is ${JSON.stringify(raw)}, which is not one of "0", "1", "false", "true"`,
  );
}

/**
 * The address this session asks for.
 *
 * `PI_AGENT_NAME` when the operator set one — that is how a session becomes `reviewer` rather than a
 * hex string nobody will type. Otherwise the session id, which is unique by construction and stable
 * for the life of the session, which is all "addressable" requires.
 */
export function preferredName(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[NAME_ENV];
  if (explicit !== undefined && explicit.trim() !== "") return slugifyAgentName(explicit);
  return slugifyAgentName(`agent-${sessionId.replace(/-/g, "").slice(0, 12)}`);
}

/** Every live poller's stop function, so the test seam can disarm registrations it replaced. */
const pollers = new Set<() => void>();

/** Test seam. */
export function __resetForTests(): void {
  for (const stop of pollers) stop();
  pollers.clear();
}

function report(ctx: ExtensionContext | undefined, key: string, line: string): void {
  surfaceOnce(ctx, key, () => {
    if (ctx === undefined) process.stderr.write(`${line}\n`);
    else emitNotice(ctx, line, "warning");
  });
}

/**
 * How an inbound message reads in the receiving session.
 *
 * The reply instruction is in the message rather than in the tool description because that is where
 * it is read: a session woken by this text has just been handed an address it did not have a moment
 * ago, and `message_agent(target=…)` pointed back at the sender is the entire reply mechanism.
 */
function renderInbound(messages: readonly Envelope[]): string {
  const blocks = messages.map(
    (m) =>
      `--- message from "${m.from}" (session ${m.fromSessionId}, ${new Date(m.at).toISOString()}) ---\n` +
      m.message,
  );
  const senders = [...new Set(messages.map((m) => m.from))];
  return [
    messages.length === 1
      ? `A peer session sent you a message.`
      : `${messages.length} peer sessions sent you messages.`,
    "",
    ...blocks,
    "",
    `Reply with message_agent(target="${senders[0] ?? "<name>"}", message="…") if a reply is warranted — ` +
      `it is fire-and-forget, nobody is blocked on you. If nothing is needed, say so and stop.`,
  ].join("\n");
}

export function register(pi: ExtensionAPI): void {
  /** This session's registered name. `undefined` until `session_start` succeeds. */
  let self: AgentRecord | undefined;
  let poll: NodeJS.Timeout | undefined;
  let streaming = false;
  /** Guards against a `turn_end` drain and a poll drain reading the same inbox at once. */
  let draining = false;

  function stopPoll(): void {
    if (poll === undefined) return;
    clearInterval(poll);
    poll = undefined;
  }
  pollers.add(stopPoll);

  /**
   * Hands whatever is in the inbox to `pi.sendMessage()`.
   *
   * Delivery branches exactly as `EXT-24`'s does, and for the same reason (PI branches on its own
   * `isStreaming`, not on anything this module tracks): mid-run, `followUp` queues the message behind
   * the current turn so the session finishes what it is doing and then reads it; idle, `triggerTurn`
   * runs it as a prompt of its own, which is what makes an idle session wake rather than wait for
   * its operator to type.
   */
  async function drain(ctx: ExtensionContext): Promise<number> {
    if (self === undefined || draining) return 0;
    draining = true;
    try {
      const { messages, problems } = await drainInbox(agentsRoot(), self.name);
      for (const problem of problems) {
        report(
          ctx,
          `message-agent:bad-envelope:${problem.name}`,
          `[pi-config] message-agent: unreadable envelope ${problem.name} kept as .bad: ${problem.reason}`,
        );
      }
      if (messages.length === 0) return 0;
      logEvent(self.sessionId, "message", `message_agent.receive:${self.name}`, true, undefined, {
        count: messages.length,
        from: [...new Set(messages.map((m) => m.from))],
      });
      pi.sendMessage(
        {
          customType: "agent-message",
          content: [{ type: "text", text: renderInbound(messages) }],
          display: true,
        },
        wakeOnIdle()
          ? { deliverAs: "followUp" as const, triggerTurn: true }
          : streaming
            ? { deliverAs: "nextTurn" as const }
            : undefined,
      );
      return messages.length;
    } finally {
      draining = false;
    }
  }

  function arm(ctx: ExtensionContext): void {
    if (poll !== undefined || self === undefined) return;
    poll = setInterval(() => {
      void drain(ctx).catch((err: unknown) => {
        stopPoll();
        report(ctx, "message-agent:poll", `[pi-config] message-agent: inbox poll stopped: ${describeError(err)}`);
      });
    }, pollIntervalMs());
    poll.unref();
  }

  function requireSelf(): AgentRecord {
    if (self === undefined) {
      throw new MessageAgentError(
        `message_agent is unavailable: this session is not registered in the directory, so it can ` +
          `neither be addressed nor address anyone. See the session_start warning or /doctor.`,
      );
    }
    return self;
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      const root = await ensureAgentsRoot();
      // Sweeping first is what makes a name reclaimable after a session was SIGKILLed: nothing
      // observes another process's exit, so the stale registration is removed by whoever looks next.
      const swept = await listAgents(root);
      for (const problem of swept.problems) {
        report(
          ctx,
          `message-agent:directory:${problem.name}`,
          `[pi-config] message-agent: directory entry "${problem.name}" is unreadable: ${problem.reason}`,
        );
      }

      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile?.();
      const result = await registerAgent({
        root,
        name: preferredName(sessionId),
        sessionId,
        cwd: ctx.cwd,
        ...(sessionFile ? { sessionFile } : {}),
      });
      self = result.record;
      if (result.record.name !== result.requested) {
        // Announced, never silent: the operator asked for one address and got another, and a message
        // sent to the address they exported would land in somebody else's session.
        emitNotice(
          ctx,
          `[pi-config] message-agent: "${result.requested}" is held by another live session; ` +
            `this one is registered as "${result.record.name}".`,
          "warning",
        );
      }
      arm(ctx);
      // A message may have been written between this session's last shutdown and this start only if
      // the name was reused; draining here costs one readdir and closes that window.
      await drain(ctx);
    } catch (err) {
      report(
        ctx,
        "message-agent:session_start",
        `[pi-config] message-agent: session_start failed, this session is not addressable: ${describeError(err)}`,
      );
    }
  });

  pi.on("agent_start", () => {
    streaming = true;
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      await drain(ctx);
    } catch (err) {
      report(ctx, "message-agent:turn_end", `[pi-config] message-agent: turn_end drain failed: ${describeError(err)}`);
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    streaming = false;
    try {
      await drain(ctx);
    } catch (err) {
      report(
        ctx,
        "message-agent:agent_settled",
        `[pi-config] message-agent: agent_settled drain failed: ${describeError(err)}`,
      );
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      stopPoll();
      if (self === undefined) return;
      await unregisterAgent(agentsRoot(), self.name, self.sessionId);
      self = undefined;
    } catch (err) {
      report(
        ctx,
        "message-agent:session_shutdown",
        `[pi-config] message-agent: shutdown failed, a stale registration may remain: ${describeError(err)}`,
      );
    }
  });

  pi.registerTool({
    name: "message_agent",
    label: "Message agent",
    description:
      "Send a fire-and-forget message to another running session by name, or list the sessions you " +
      "can reach. The message wakes the target session; it does not block this one and there is no " +
      "return value beyond the delivery receipt. A reply comes back as a message_agent call pointed " +
      "at you, not as this tool's result.",
    promptSnippet: "Message another running session by name",
    promptGuidelines: [
      "Use message_agent(action=\"list\") first when you are not certain a name is live — a message to an unknown name is refused, not queued.",
      "message_agent does not wait for an answer: say what you need and carry on, and handle the reply when it arrives as an incoming message.",
      "To reply to a message you received, call message_agent with target set to the sender's name.",
      "Use teammate for a child session you spawned and are waiting on; message_agent is for peers you did not spawn.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["send", "list", "whoami"] as const, {
          description: 'what to do; defaults to "send"',
        }),
      ),
      target: Type.Optional(
        Type.String({ description: "the name of the session to message; required for send" }),
      ),
      message: Type.Optional(Type.String({ description: "what to say; required for send" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const root = await ensureAgentsRoot();

      switch (params.action ?? "send") {
        case "list": {
          const listing = await listAgents(root);
          return {
            content: [{ type: "text" as const, text: renderDirectory(listing, self?.name) }],
            details: {
              self: self?.name,
              agents: listing.agents.map((a) => a.name),
              problems: listing.problems,
            },
          };
        }

        case "whoami": {
          const me = requireSelf();
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `This session is addressable as "${me.name}" (session ${me.sessionId}, pid ${me.pid}). ` +
                  `Peers reach it with message_agent(target="${me.name}", message="…").`,
              },
            ],
            details: { name: me.name, sessionId: me.sessionId, pid: me.pid },
          };
        }

        case "send": {
          const me = requireSelf();
          const target = params.target;
          const message = params.message;
          if (!target) throw new MessageAgentError(`message_agent: action="send" needs a "target".`);
          if (!message) throw new MessageAgentError(`message_agent: action="send" needs a "message".`);
          if (target === me.name) {
            throw new MessageAgentError(
              `message_agent: "${target}" is this session. Talk to yourself in your own reasoning, ` +
                `not through the directory.`,
            );
          }

          const record = await requireAgent(root, target);
          const envelope = await deliver({
            root,
            target: record.name,
            from: me.name,
            fromSessionId: me.sessionId,
            message,
          });
          logEvent(me.sessionId, "message", `message_agent.send:${record.name}`, true, undefined, {
            id: envelope.id,
            chars: message.length,
          });
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `delivered to "${record.name}" (session ${record.sessionId}, pid ${record.pid}) as ` +
                  `${envelope.id}. It will be woken with it; nothing is returned here — a reply, if it ` +
                  `sends one, arrives as an incoming message addressed to "${me.name}".`,
              },
            ],
            details: { id: envelope.id, target: record.name, targetSession: record.sessionId, from: me.name },
          };
        }
      }
    },
  });

  pi.registerCommand("peers", {
    description: "List the running sessions this one can reach with message_agent",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      const listing = await listAgents(await ensureAgentsRoot());
      ctx.ui.notify(renderDirectory(listing, self?.name), listing.problems.length > 0 ? "warning" : "info");
    },
  });
}
