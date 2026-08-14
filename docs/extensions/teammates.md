# `teammates` — named long-lived child sessions

Registers the `teammate` tool and `/teammates`.

**Not a dispatcher.** [`dispatch`](dispatch.md) and the sub-agents package own delegation. This is
the part no package supplies: a child session that stays alive under a name, with a **delivery
obligation welded into the spawn path** rather than into a prompt somebody hopes was read.

## Why the obligation is structural

The failure this fixes is specific and was measured on the predecessor harness: five long-lived
children each finished a complete report, none of them called the delivery tool, and the lead
received five empty idle notifications. Every report existed; none was delivered. The instruction to
deliver had been written in the spawn prompt, and the spawn prompt is not a contract.

So:

1. **The obligation is appended by the runtime.** The delivery contract is welded into every
   child's system prompt, the reply tool is injected, and the agent's tool allowlist is widened so
   the tool is reachable. **An agent file cannot opt out; a caller cannot forget.**
2. **Bounded reminders, not a hard block.** At most two reminders, then release with `abandoned`
   recorded. A hard block is how you get an infinite stop-hook loop.
3. **A distinct tool name.** `teammate`, not `subagent`. The two return contracts differ in exactly
   the way that produces silent data loss, so they do not share a name or a mental model — and the
   tool description says so in its first sentence.
4. **A named session-scoped registry**, so `reviewer` still means the same live session three turns
   later.

## Naming is the opt-in to the expensive mode

Structurally enforced: there is no way to reach this module without calling a tool called `teammate`
and passing a name. Everything else routes through ordinary [dispatch](dispatch.md), which is
cheaper and returns its result the ordinary way.

Reach for a teammate when the children need to talk to each other, or when you will send them
follow-up messages by hand. For "do this, give it back", use `subagent`.

## Spawning is off until a spawner is wired in

Out of the box, `teammate(action="spawn")` **refuses**, names the `subagent` tool (one call per
agent, or a `workflowScript` with `runs.all([...])` to fan out) and stops. Nothing is started.

The reason is a missing piece, not a missing feature. Opening a real child session needs a callback
that turns an agent's `provider/id` into the model object the SDK session wants, and that callback
comes from the host's model registry — an extension cannot build one. Constructed without it, the
session spawner used to fail *after* the tool call was accepted, from inside the SDK, with a message
blaming the agent file or the provider configuration; neither was at fault. Refusing at the tool
boundary is the same outcome one layer earlier, where the message can be useful.

Guessing a model instead was rejected on purpose: it trades a loud failure for a teammate quietly
running on a model its agent file never asked for.

To turn spawning on, register the extension with a spawner that can resolve models:

```ts
register(pi, { spawner: createSdkSpawner({ resolveModel }) });
```

`createSdkSpawner` is exported from `extensions/teammates/runtime.ts` and is otherwise unchanged.
Everything else the module does — `send`, `list`, `close`, the delivery obligation, the stranded-work
notices — works against whatever spawner is supplied, which is also how the tests drive it.

## Related
[dispatch](dispatch.md) · [jobs](jobs.md) · [Adding a sub-agent](../extending/subagents.md)
