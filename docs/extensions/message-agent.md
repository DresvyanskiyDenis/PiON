# `message-agent` — peer-to-peer messaging between running sessions

Registers the `message_agent` tool and `/peers`.

**Not a transport.** `pi.sendMessage()` already wakes a session, and four modules use it for exactly
that — [dispatch](dispatch.md) for a finished sub-agent, [jobs](jobs.md) for a finished job,
[tasks](tasks.md) for a stale task, [context-imports](context-imports.md) for nested instructions.
But it is a handle on the *calling* session's own turn loop, so it delivers the last hop and nothing
before it. [`teammates`](teammates.md) addresses children by name through a registry that lives in
the lead's process, so a sibling cannot read it and nothing that did not do the spawning can either.

The missing middle is the **routing**, and this module is only that: a directory on disk that says
which names are live, and one inbox per name that any session may write into and only its owner
drains.

## The directory

```
<state>/agents/<name>/
  agent.json          {schema, name, sessionId, pid, cwd, sessionFile?, startedAt}
  inbox/<id>.json     one undelivered message each
  inbox/<id>.bad      an envelope that would not parse, kept rather than deleted
```

`<state>` is `$XDG_STATE_HOME/pi-config` — runtime state, never the config tree, for the same reason
[`jobs`](jobs.md) puts its store there: a configuration tree that carries another machine's runtime
state with it is a configuration tree that cannot be copied.

Every write is temp-file-then-rename, so a concurrent reader sees either no file or a whole one, and
two senders never contend. There is no lock anywhere in this module.

**Liveness is a pid, checked at read time.** Nothing observes another session's exit — a session
that is `SIGKILL`ed never runs `session_shutdown` — so a registration is a *claim*, verified by
whoever looks next. A name whose process is gone is swept, and can then be claimed again.

## Addressing

A session registers at `session_start` under `PI_AGENT_NAME`, slugified, or under
`agent-<first 12 of the session id>` when that variable is unset. `PI_AGENT_NAME=Reviewer` makes a
session addressable as `reviewer` rather than as a hex string nobody will retype.

A collision with a **live** holder resolves to `<name>-2` and is **announced**, never applied
silently: two sessions answering one address is the failure this directory exists to prevent, and a
message sent to the address the operator exported would otherwise land in the wrong session.

## Delivery

`message_agent(target="reviewer", message="…")` returns when the envelope is on disk — never when it
is read. The target drains its own inbox at `turn_end`, at `agent_settled`, and from a 2-second
`unref`'d poll, then hands what it found to `pi.sendMessage()` with `deliverAs: "followUp"` and
`triggerTurn: true`. That last flag is what makes an **idle** session wake rather than wait for its
operator to type.

A poll, not `fs.watch`: watching is per-platform, drops events under load, and has to be re-armed
after every rename. One `readdir` of an almost-always-empty directory every two seconds is cheaper
than that failure mode. Unlike [`jobs`](jobs.md)'s self-arming watcher, the poll runs for as long as
the registration does — a message can arrive from a session this one has never heard of.

An envelope that will not parse is renamed `<id>.bad` rather than deleted. It is somebody's message:
the drain must neither loop on it forever nor lose it.

## Replying

The reply path is the same tool pointed the other way, and the inbound message text says so
verbatim. There is no third contract to learn, and [`teammates`](teammates.md)' `reply_to_lead` keeps
its single meaning — that module is untouched by this one.

## Actions

| Call | Does |
|---|---|
| `message_agent(target=…, message=…)` | sends; `action` defaults to `"send"` |
| `message_agent(action="list")` | every reachable session, this one marked |
| `message_agent(action="whoami")` | the name this session actually registered under, suffix and all |

`/peers` prints the same directory listing as `action="list"`.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `PI_AGENT_NAME` | the session id | the address this session asks for, slugified |
| `PI_AGENT_POLL_MS` | `2000` | inbox poll interval; a malformed value throws rather than silently restoring the default |
| `PI_AGENT_WAKE` | `1` | `0` renders an inbound message without starting a turn for it |

## What it is not

- **Not cross-host.** A pid is only meaningful on the machine that owns it. Messaging between hosts
  would need a heartbeat timestamp instead, and is not built.
- **Not authenticated.** Any process running as this user can write into any inbox — the same trust
  boundary [`jobs`](jobs.md) already has, stated rather than assumed.
- **Not durable.** A message delivered to a session that dies before it drains is swept with the
  registration. Keeping undelivered mail past the addressee's death would mean a message arriving in
  a session that never asked for it, which is the worse failure.

## Related
[teammates](teammates.md) · [jobs](jobs.md) · [dispatch](dispatch.md) ·
[session-index](session-index.md)
