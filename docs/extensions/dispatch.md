# `dispatch` — tiers, depth, concurrency, isolation

**There is no dispatcher in this module.** The adopted sub-agents package is the dispatcher: agent
discovery, the Markdown+frontmatter format, per-agent models and tool sets, structured delegation,
per-agent permissions, worktrees, the async fleet.

What ships here is the remainder. Configured by
[`config/dispatch.json`](../configuration/dispatch.md) and
[`config/routing.json`](../configuration/routing.md).

Registers `/agents`.

## The parts

| Part | What it does |
|---|---|
| `depth.ts` | A depth limit that fails **loudly at dispatch**, on our number |
| `semaphore.ts` + `concurrency.ts` | Per-provider concurrency from `routing.json`, **queueing rather than erroring** |
| `isolation.ts` | Honours `isolation: worktree`; the worktree itself comes from [`worktree`](worktree.md) |
| `tiers.ts` | Tier name → `provider/id`, from `routing.json`, the single source of truth |
| `catalogue.ts` | The model registry as a dispatch surface |
| `thinking.ts` | The reasoning-effort suffix: what was asked, what the model serves, what will actually run |
| `async-fleet.ts` | Re-reads the state a background run wrote for itself, and announces the ones that ended |
| `async-resume.ts` | Gives an async run that came back **empty** one automatic `resume`, once, ever |

## The two non-negotiable acceptance criteria

1. **A typo in an agent file is a `session_start` error**, not a surprise forty minutes into a long
   run. When a tier once named a model id that did not exist in the provider's catalogue, eight
   agent definitions refused to dispatch at session start, each naming itself and the tier. That is
   the design working.
2. **Naming a concrete `provider/id` is not a way around the existence check.** A tier is resolved
   and verified at `session_start`; a raw id typed at the call is verified at the call, against the
   same registry, and refused with the closest real ids. Neither path can reach a model nothing
   serves.

!!! note "There used to be a third one, and it was withdrawn on 2026-08-13"

    Until then this list also read *"a confidential session cannot dispatch onto a public
    provider"*, and the module enforced it: the resolved provider's egress class had to be no
    looser than the session's, at load time and at call time.

    It was removed because it refused far more than it protected. Most providers are classed looser
    than a confidential session, so most agents became undispatchable and switching provider
    mid-session was impossible — while nothing about the actual network changed either way, since
    the class is a word in a config file and no socket is inspected. The classes stayed; the refusal
    went. They are printed wherever a model or an agent is listed, and refuse nothing.
    [ADR 0004](../adr/0004-egress-classes-are-declarative.md).

## The catalogue is a dispatch surface, not decoration

A model cannot choose an id it does not know exists. So:

- a call-time `provider/id` is checked for existence, and a bad one is refused **with the closest
  real ids**;
- the selectable set is injected into the system prompt at `before_agent_start` as a **Sub-agent
  model selection** block, so the orchestrating model can spend deliberately — a mechanical sweep on
  a small model, a hard decision on a large one — instead of guessing an id.

The list is **annotated, not filtered**: every id the registry knows is shown, each with its
provider's egress class — or `unlabelled`, when `routing.json` gives that provider no class. Since
nothing refuses a dispatch on account of a class, hiding models by class would only shorten the menu
while leaving them selectable by hand. Each tier line carries the same annotation plus the reasoning
effort it resolves to, so the cost of a choice is visible at the point of choosing.

Until 2026-08-13 the list was filtered by the session's own class and what had been removed was
counted on one line. The filter went with the containment rule it implemented.

## Reasoning effort is disclosed, never assumed

A reasoning effort rides inside the model string as a suffix (`provider/id:max`), and that suffix is
a **request**: PI clamps it against the model's declared vocabulary before the wire. Nothing warned
about that, so a run commissioned at `max` could ship at `high` and record `max` in its own metadata
— visibly wrong only to someone who went looking.

Now every dispatch that would be clamped says so, naming the requested level, the effective one,
what the model does serve, and which other configured providers serve what was asked — each with its
egress class, because moving between classes is the operator's decision and not a routing
optimisation. It is a hint: **nothing is rerouted**. The model string is rewritten to the effective
level before the package sees it, so the run metadata and the announcement agree with the wire.

The menu prints the same thing rather than the request alone — `effort high (asked max; <provider>
does not serve it — serves low|medium|high)` — and `/agents` lists any tier in that state under
`reasoning effort CLAMPED:`. A model whose vocabulary the registry does not know produces no
disclosure and no rewrite: "cannot say" must not render as "no clamp will happen". Whether a clamp
warns or refuses is
[`onThinkingClamp`](../configuration/dispatch.md#onthinkingclamp).

## Async runs announce their own terminal state

`pi-subagents` acknowledges an async dispatch with a promise to wake you when it finishes. When that
delivery path fails, nothing enters the transcript at all — and the acknowledgement is then the only
in-context evidence the orchestrator has, so it keeps reporting a run that died seconds ago as live.
Measured: every async result file of one session still on disk, undeleted, `"state": "failed"`, and
zero notifications in the transcript.

This module does not add a second lifecycle. The authoritative state is already on disk in the run's
own `status.json`, written by the package's runner; the only thing missing was that nobody read it
unless the model thought to ask. So each async spawn's directory is remembered, re-read at
`turn_end`, and each run that has reached a terminal state and has not been reported yet produces one
message. `paused` is deliberately **not** terminal — announcing it would spend the run's single
announcement and hide the real ending.

Duplication was chosen over silence: if the package's own notification does arrive, you may hear
about a finished run twice. Being told twice is a nuisance; not being told is a wrong answer. The
upstream delivery failure is routed around, not repaired.

That trade does **not** extend to your own reads. A run you waited on, polled, or read the artifact
of is marked consumed and never announced — the announcement is for the run nobody told you about.
Measured 2026-08-26: one run was waited on, polled, read and its todo closed, and the announcement
arrived two minutes later saying "read the artifact above". That is not a doubled report, it is a
stale instruction to reconcile against work already done. Consumption requires the run's own
`status.json` to be terminal at the moment you looked: polling a run that is still running says
nothing about how it ends, so it does not spend the announcement, and neither does reading a run
that never wrote a `status.json` — "never started" still gets said.

The block is built once at `session_start` and is byte-identical for the rest of the session, so it
does not churn the prompt-cache prefix. `/agents` prints the same text **verbatim** — if the human
and the model are reading different lists, the one nobody can see is the one that is wrong.

## An async child that came back empty gets one follow-up

Reporting a failure is not recovering from it, and one failure is worth recovering from
automatically: the run that ended carrying the runner's own words —
`Subagent produced no output (possible model cold-start or empty response).` — a cold start or a
dropped first token, where the work was never attempted and re-dispatching by hand costs a full
prompt again.

[`config/settings.default.json`](../configuration/settings.md#subagentswatchdog) has asked for that
recovery since the block was written, under `subagents.watchdog.asyncCompletion`. The pinned
`pi-subagents` parses the key and reads it in no runtime, so the request went nowhere.
`async-resume.ts` is the consumer on this side: when the `turn_end` sweep reconciles a terminal run
whose error carries that sentence, one `resume` goes out over the package's in-process RPC
(`subagents:rpc:v1:request`) with a message telling the child to produce its result, partial if need
be, rather than to try again in the abstract. Nothing upstream changed — the canary in
[`test/dispatch/watchdog-settings.test.ts`](../operations/verification.md) still asserts that the
package itself consumes the setting nowhere, and the day that fails, this module is what should be
re-read.

**Gated on both flags, and only those.** `watchdog.enabled` AND `asyncCompletion.enabled`, both
literally `true`, read from the agent settings file the package itself reads. The AND is the
package's own composition rule, and both flags ship OFF upstream, so anything looser would turn this
on for a tree that never asked for it. `asyncCompletion.autoFollowBlockers` is read, reported, and
deliberately does not gate anything here: a *blocked* child — one that came back with a question or
a stated obstacle — is a different recovery with a different message and a different budget, and it
belongs to the watchdog's own follow-up cycle.

**One attempt, enforced against a file.** The failure being recovered from is "the child said
nothing". A resume that also says nothing is the same failure, and answering it the same way is a
loop that spends a model call per iteration for as long as the session lives. So the budget is one
per run, recorded in `~/.local/state/pi-config/dispatch/async-resume.jsonl` **before** the request is
emitted — a crash between the write and the send costs one lost follow-up, a crash the other way
round would cost an unbounded number of them — and a ledger that cannot be written means no request
at all. The run a successful resume starts is stamped as spent before it is adopted into the fleet,
so its ending is announced like any other run's while it can never earn a follow-up of its own. That
is what stops a chain of empty children from walking the budget forward one run at a time.

The outcome — resumed, refused, or no reply inside 30s — arrives as one message, and the terminal
announcement marks the run it already answered for with `↻` and withdraws the re-dispatch
instruction for it. Telling the model to re-dispatch a run the harness is already resuming is two
instructions that contradict each other, and it can only obey one.

## The fleet is on screen, not behind a command

The announcement above is written for the model. It fires once per run, and only after the run is
over — so it is not the surface that answers *"is anything still running?"*.

In the TUI, a panel above the editor carries that: every async run this session is still tracking,
with the state its own `status.json` reports right now, present exactly while at least one run is
tracked and gone the moment none is.

```
async subagents — 1 running · 1 done · 1 needs attention
  ▸ data-engineer [66971211] running
  ✓ code-reviewer [6e77fc27] complete
  ? researcher   [a4c167dd] NEVER STARTED
```

Four glyphs, no colour: `▸` live, `✓` finished, `✗` failed, `?` never started. The distinction is
shape rather than hue, so it survives a screenshot, a colour-blind reader and a terminal that has
quantised the palette. `NEVER STARTED` is the case only this module can report — a run the package
handed back an id for and then never recorded a start for, which a fleet view built on the
package's own run list cannot show, because the run never registered.

`/agents` prints the same verdicts outside the TUI. It carries the dispatch registry as well — what
*can* be dispatched, on what model — which is a catalogue, not live state, and would be wrong as a
permanent panel. The panel makes the common case free; it does not take a diagnostic away.

!!! note "Why it polls, and what that costs"
    The state lives on disk and changes with no event reaching the process: a run completes while
    the model is mid-stream, or while you are typing. Repainting only at the end of a turn would
    produce a panel that is confidently wrong for exactly as long as you are looking at it;
    repainting on a per-token event would re-read every status file per token.

    So there is one interval — one `readFileSync` per tracked run per second — and it exists only
    while a run is tracked. It is `unref()`d, so it can never hold the process open; it stops itself
    on the first tick that finds nothing to show; and it is torn down at session shutdown. That
    middle bound was unreachable until the fleet learned to retire what it had reported — with
    nothing ever removed, a session was never empty again after its first async run — which is why
    the tick runs the retirement sweep itself: the poll is the only thing still ticking once a
    session goes idle, so it is the only place that can retire the last settled run. The tests
    wrap `setInterval`/`clearInterval` and require zero timers created outside the TUI, zero while
    the fleet is empty, exactly one across repeated refreshes, and zero still open afterwards.

    Outside the TUI nothing is painted and no timer is started. The guard is the run mode, not
    `hasUI` — `hasUI` is true in RPC mode too, where there is no editor for a widget to sit above.

!!! note "It is a display, not a control, and `/compact` does not change that"
    Reported as "after `/compact` the panel is still displayed but the down arrow no longer selects
    the async runs", with a prescribed fix of repainting the panel from a `session_compact` handler.
    Both halves are wrong, and no code change was warranted.

    The panel has never been selectable, before or after any compaction. It is published as a
    `string[]`, which the host wraps in a `Container` of `Text` components — there is no
    `handleInput` on that, and `ExtensionWidgetOptions` carries `placement` and nothing else.
    Widgets are never given focus either; `setFocus` is applied to overlays and selectors only. A
    repaint cannot make a `Text` container take a keypress, and this panel already repaints every
    second.

    Compaction does not disturb widgets at all. `/compact` only compacts the session; the host's
    widget and terminal-input registries are cleared solely on session replacement and on `/reload`,
    which are also the only events that make a captured `ExtensionContext` go stale — which is why
    the pinned context this poll paints from survives a compaction.

    Selection lives in the `pi-subagents` fleet view, the `belowEditor` line reading "↓/← to
    inspect": it registers a component *factory* and owns a terminal-input subscription, and it
    stays enabled. One thing there does go quiet around a compaction, and it is upstream policy
    rather than anything this module can shorten: an **automatic** pass suspends the package's
    widgets, clearing the fleet view and making its key handler decline the key until the agent
    settles. A manual `/compact` is exempt by the same guard, and either way it is a window inside a
    turn, not a stuck state.

!!! warning "Why this is the *only* widget above the editor"
    `config/subagent.default.json` sets `asyncWidget: false`, which turns off the `pi-subagents`
    package's own above-editor block for active background runs. That is a bug fix, not a
    preference for our own rendering.

    Two `aboveEditor` widgets do not stack in a stable order. The host keeps same-placement widgets
    in a `Map` and renders them in insertion order, but `setWidget` **deletes the key and
    re-inserts it on every update** — content-only changes included. Re-insertion moves a key to
    the tail, so the rendered order is *least-recently-painted first*: whichever block painted most
    recently sinks to the bottom. With two painters on unsynchronised timers that is not a
    tie-break, it is a flip, and at a sub-second repaint rate the two blocks visibly swap places
    several times a second. Nothing in PI's extension or TUI documentation specifies ordering among
    same-placement widgets — only `placement` itself — so it is an emergent property of the
    implementation rather than a contract. **If you add a second `aboveEditor` widget, this is what
    you are joining.**

    Being the sole painter is the only fix for that; height-locking one of two blocks does nothing
    about their order. It is also why this panel gates its own repaints on a text diff of what it
    last painted: an unchanged tick that called `setWidget` anyway would re-order the widget for
    free.

    The panel is a fixed block in its own right, too. It truncates every line by **display width**
    rather than `String.length` — a CJK glyph is one UTF-16 unit and two columns, a combining mark
    one unit and zero — because a line that overruns the terminal wraps, and a wrapped line costs a
    row exactly as an extra line would. And it honours the host's own `MAX_WIDGET_LINES` of 10:
    past that the host truncates the array *and appends a line of its own*, so the panel degrades
    deliberately instead, and says how many runs it is not showing rather than dropping them
    silently.

    What this does not turn off: FleetView keeps its default `belowEditor` placement, so the Fleet
    inspector (`Ctrl+Alt+F`), `/subagents-fleet`, completion notifications and lifecycle events are
    all untouched.

### What the fleet forgets, and when

Both surfaces list what the fleet is still *tracking*, which is not the same as everything it ever
started. A run is retired from the fleet two minutes after it settles:

- a run that reached a terminal state, or never wrote a `status.json` at all, is retired once it has
  been **reported** — announced to the model, or read by the model itself — and two minutes have
  passed since the first sweep that saw both. The ledger gate is what stops a run being dropped
  before its ending is in the session;
- a `paused` run whose runner has **provably exited** is retired on the two minutes alone. The proof
  is the runner's own `<asyncDir>/process-terminal.json` in state `observed`; the other three states
  it may carry (`pending`, `unknown`, `not-started`), and an absent or unparseable file, all mean
  "cannot say" and keep the run. Such a run is never announced — `paused` is not terminal, because
  it really can be resumed — so requiring the ledger for it would be requiring something that can
  never happen.

The pid in `status.json` is deliberately **not** consulted. A pid freed hours ago is very likely
reissued, so `process.kill(pid, 0)` reports a dead runner as alive — the exact failure being fixed,
made permanent; `kill` across uids throws `EPERM`, which also reads as alive; and the field is
optional, so a condition resting on it cannot fire at all for a run whose status file never carried
one.

Retiring removes the run from the panel and from `/agents` and does nothing else: the run directory,
its `status.json`, its session file and its resumability are untouched, and `/subagents-fleet` still
lists it, because that view re-derives runs from disk. That is the cost, stated plainly — `/agents`
no longer lists a run that ended more than two minutes ago, and it says *tracked by this session*
rather than *started by* because of it.

Without this the fleet only ever grew. Every finished run stayed in it for the life of the session,
so the poll above re-read fifty dead status files a second for an hour; the panel filled with
history and pushed the running children behind "… and N more"; and — measured on one real session —
106 paused runs whose runners had exited sat on the panel as running children, the oldest 276
minutes old.
## What a detached child leaves in the session file

A run that was detached or interrupted is still *running* when its result is handed back, and the
package's own compaction of a finished result bails out on exactly that condition. So those runs —
and only those — hand the parent the child's live message array inside the tool result's `details`.

That costs nothing at the model: `details` is documented as not sent to the LLM, and the provider
layer serialises the tool call id, the content and the error flag and reads nothing else. It is
written verbatim into the session file, though, and `bin/pi-digest-drain` summarises that file **by
byte count** — the last `maxTranscriptBytes` of it. A child transcript landing there pushes an equal
number of bytes of real conversation out of the window the summariser is shown, and nothing in the
resulting [digest](digest.md) says anything is missing.

So the `tool_result` handler drops that array, and **only while the child still says where its full
record lives** — its `transcriptPath` or its `sessionFile`. When neither survives, the array in hand
is the only copy of what that child did, and a run that died without writing a transcript is exactly
the run somebody will want to read; it is kept, and the result is passed on untouched. Nothing else
is ever removed: the bounded `progress` snapshot, the final output, the error, the tool-call
summaries and the async run's own `asyncId`/`asyncDir` all ride through as they arrived.

## Load order

[`guard`](guard.md) **must** load before this module. PI iterates `tool_call` handlers in load order
and returns on the first block; a blocked dispatch must never have had its arguments rewritten
first.

This module in turn must load before [`teammates`](teammates.md), [`worktree`](worktree.md) and
[`jobs`](jobs.md), which register providers and vetoes into registries it owns.

## Why a `tool_call` handler and not a tool

The dispatch tool belongs to the package. Everything this module does to a dispatch — resolve a
tier, lower a fan-out width, point a child at a worktree, refuse a call — is a mutation of or a veto
on a call the package's tool receives. Registering a competing tool would give the model two ways to
do the same thing, one of them unguarded.

## The workflow floor, and the package internal it rests on

A `workflowScript` call launches children *inside* the package, past the point where this module
turns a tier word into a `provider/model`. A child that names no model therefore arrives at PI's own
substring matcher carrying its agent file's tier word, and that matcher will resolve a word like
`light` onto whatever provider id happens to contain it — routing by accident, onto a provider
`models.json` never declared, surfacing as a credentials error rather than as the substitution it
is.

So when a `workflowScript` names no `model`, the resolved
[`defaultTier`](../configuration/dispatch.md#defaulttier-and-defaultegress) is written onto the call
as a **floor**: `pi-subagents` keeps a top-level `model` in its workflow child defaults and spreads
it *underneath* each child's own parameters, so children that name no model inherit it and children
that name one are untouched. The pin is announced when it happens, in wording that says it is a
floor and what overrides it.

This is the one rule in the module that depends on a package **internal** rather than on a
documented argument (`pi-subagents` 0.41.0, `src/runs/foreground/subagent-executor.ts`, the
`workflowChildDefaults` destructure and the child-params spread). `test/dispatch/rules.test.ts`
asserts that source's shape directly, so an upgrade that drops `model` from the defaults, or flips
the spread order, fails the suite instead of quietly changing what a fan-out runs on. Re-check it
whenever the package is upgraded.

## What a resolution leaves behind

`/agents` describes what **can** be dispatched. It cannot answer *what did this delegation actually
run on, and why* — so every resolution is written to the [session index](session-index.md) as one
row, under kind `dispatch` and name `dispatch.resolve:<agent>`. That is the same
`<domain>.<action>:<subject>` shape [teammates](teammates.md) writes into the same bucket, so
`/index` and `bin/pi-log events` read one stream rather than two incompatible ones.

The payload carries identifiers only: the `subagent` tool the call came in on, the agent named, the
resolved provider, and the model record — where the spec came from (`from`), what it resolved to
(`to`), the tier if it came from one, and `defaultedScope` when the value was the
[`defaultTier`](../configuration/dispatch.md#defaulttier-and-defaultegress) rather than something
asked for. The clamped concurrency and the isolation appear too, when either was applied.

Two properties are deliberate, and a consumer of `/index` has to know both:

- **The row is written on resolution, not on rewrite.** "The call already named exactly the model we
  resolved to" is still a resolution worth recording; keying the row off the rewrite would silently
  under-report a real share of delegations.
- **A refused call writes no `dispatch.resolve` row.** The block is already carried by the guarded
  handler's own audit entry, and a call that resolved no model has nothing to say about what it ran
  on. Reading only this kind therefore counts delegations that proceeded — the refusals are in the
  other place.

Logging cannot fail a dispatch. The write swallows its own failures by contract, and the session-id
lookup that precedes it is wrapped, so an unwritable index degrades the event log and leaves the
verdict and the arguments exactly as they were.

## A blocking wait does not wake on heartbeats

`subagent_wait` is the one tool in `dispatch`'s rule set that dispatches nothing: it blocks. The
`DSP-WAIT` rule fires on it, writes `stopOnAttention: false` onto a blocking call that did not name
the flag, and never blocks or refuses.

The reason is that `pi-subagents` resolves the flag as
`params.stopOnAttention ?? deps.stopOnAttention !== false`, so an omitted parameter means **true**
and the wait ends on *any* `needs_attention` run. Two of the three producers of that state are
heuristics rather than questions: idle beyond 60 s (scaled ×2/×5/×10 for medium/high/xhigh thinking)
and one tool call open for 240 s or more. A child thinking hard, or four minutes into one `bash`, is
not asking the lead anything, and each of those wakes costs the lead a full re-read of its context
at cache-miss price.

Nothing is lost by lowering it. The genuine ask, a pending `contact_supervisor`/intercom request, is
checked *independently* of the flag (`isDone()` reads `stopOnAttention || hasSupervisorTool(run)`),
and terminal states and the timeout are separate branches of the same predicate.

It is a call rewrite and not a key because the package exposes no key: the wait tool's own config
resolves to `{ enabled }` and nothing else, and `subagents.watchdog` is a strict parser that rejects
unknown fields. The only injector of the dep is the package's internal auto-drain, which passes
`false` — upstream agrees with the value, it just does not expose it. Patching `node_modules` is not
the alternative; `PC-21` keeps the vendored tree unmodified and the installed tree is what runs.

- An explicit `stopOnAttention` on the call always wins, in either direction.
- A `nonBlocking: true` subscription is left alone: it returns before the flag is read.
- `waitStopOnAttention: true` in `dispatch.json` restores the package default by writing nothing.
- The first rewritten wait of a session announces the changed semantics once, because the package's
  own tool description still advertises the opposite.

## Where the semaphore cannot reach

Documented honestly in `extensions/dispatch/concurrency.ts`: there is no extension-visible hook
inside PI's own `Promise.all` phase, so parallelism PI initiates internally is outside its scope.

## Related
[`dispatch.json`](../configuration/dispatch.md) · [`routing.json`](../configuration/routing.md) ·
[Adding a sub-agent](../extending/subagents.md) · [teammates](teammates.md)
