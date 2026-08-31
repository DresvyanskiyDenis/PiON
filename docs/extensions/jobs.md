# `jobs` — background work that outlives the session

Registers the `job` tool: start, wait, read, list, kill, prune.

## The gap it fills

Two faces of background work are already packaged and are **not** rebuilt here — the sub-agent
package's async runs (machine-readable lifecycle artifacts, a wait tool, a background-work
registry) and a background-tasks package's bash face (start, wait, logs, stdin, signals, terminate,
replay on reattach).

**Both are session-scoped.** Neither survives the `pi` process that started the work, and neither is
discoverable from a different session.

That gap is this module. A job store lives at `<state>/jobs/<id>/` outside the repository, and the
module publishes it into the packaged registries so the packaged faces can see our jobs too.

## When to reach for it

A build, a test suite, a long migration — anything whose runtime exceeds a bash timeout, or that you
want to start now and read the result of after a compaction, a `/reload`, or tomorrow.

The alternative is a bash call with a very long timeout, which holds the session hostage for the
duration and loses everything if the session ends.

## Where a running job shows up

Two surfaces, and they are not the same thing. The footer carries a **count** (`2 bg`). The fleet
panel below the editor carries a **row per job**, rendered as `external · <label>` next to the
sub-agent package's own children, because the store is published into that package's external-run
registry.

Both are written the moment `job(action="start")` returns, so a job you were just told about is on
the panel straight away rather than at the end of the turn, and again on every sweep and at
`session_start` — a session resumed with jobs still running gets its rows back. The rows are
withdrawn at `session_shutdown`; the jobs themselves keep running, and the next session that opens
the store re-publishes them.

Only *running* jobs of *this* session are published, at most 20 of them: the panel renders active
states only, filters by session, and cuts its snapshot at 20 rows, so anything beyond that could
not be shown and would only spend a cache shared with every other producer.

A job whose id or session path would not survive the panel's own display sanitiser is skipped
rather than rewritten — an identifier quietly repaired is an identifier nothing else can find —
and a registry that fails to accept our rows is reported once and otherwise ignored. The footer
count is an independent surface and keeps working either way.

## How you hear that it finished

A detached child is deliberately `unref()`d so it can outlive the `pi` process, which means
nothing observes its exit — the store is reconciled by whoever asks. So the extension polls while
any job is running, every two seconds (`PI_JOBS_WATCH_INTERVAL_MS`, in milliseconds, if you want a
slower or faster sweep), and stops polling the moment none is. An idle session pays nothing for a
watcher it does not need.

How the notice reaches you depends on what the session is doing:

| Session state | Delivery |
| --- | --- |
| An agent run is in flight | Queued behind the current turn, so the notice does not steer the turn already running |
| Idle | Starts a turn of its own, so the agent picks the job up without being asked |

The idle case is the one worth stating plainly: **a finished job wakes the agent.** Something
started that job on purpose, and a report nobody is awake to read is not a report — the alternative
is a notice sitting in a transcript until a human happens to type. The cost is bounded: one wake per
job, several jobs finishing together are a single message, and the notice tells the agent it may
stop straight away when there is nothing to do.

Set `PI_JOBS_WAKE=0` if you would rather it stayed quiet. The notice still renders, it simply never
starts a turn, and `job(action="output")` is one call away when you come back. Anything other than
`0`, `1`, `false` or `true` is an error rather than a guess — a mistyped `PI_JOBS_WAKE=off` should
not silently leave the wake switched on.

`state.json`'s `finishedAt` is the process's real exit time, read from the `exit` file's mtime, not
the moment something got round to looking.

### `job(action="wait")` instead of polling `status`

The push above exists so the model never has to poll — but polling was still what the tool told it
to do: `job(action="status")` costs one full request per check, re-sending the whole transcript
every time, and a job watched that way can cost dozens of requests to learn a single fact. `wait`
blocks the tool call itself until a job finishes, the caller's `timeoutSeconds` (default 300,
clamped to 1–3600) elapses, or the call is aborted, sleeping on the same interval the push watcher
already runs on — so waiting out a ten-minute job costs one tool call, not forty-odd.

A `wait` with no `id` is scoped to this session's own running jobs and returns at once when there
are none — another session's job can never be announced here, so blocking on the deadline could not
produce an answer. A `wait` naming an `id` may watch a job owned by another session, matching the
cross-session authority `action="kill"` already has. Either way the result reports **every** job of
this session that finished while the wait ran, not only the one it was asked about, and it reports
rather than also pushing an announcement for them — the caller is already awake and reading the
result. `action="status"` is still there for progress on a job you are not waiting for; the
guidelines steer the model away from looping on it to detect completion.

## Looking through them yourself — `/jobs`

`job(action=…)` is a tool the *model* calls. `/jobs` is the half you drive: an overlay listing
every job in the store newest-first with its id, kind, status, exit code, duration and age, and a
detail pane you can scroll through its `stdout.log`, `stderr.log` and `cmd.sh`. Detached jobs are
exactly the ones you cannot watch as they run, so this is the only way to see one mid-flight
without asking the model to fetch it for you.

Two properties are enforced in code, not left to good behaviour:

- **Read-only.** Every read goes through `listJobsSync()`, which judges whether a job is still
  alive without persisting the verdict. The ordinary `listJobs()` defaults to `reap: true` and
  *writes*, so the browser never calls it. Log files are opened `"r"` and tail-read, 64 KiB at
  most, with the leading partial line dropped rather than shown as if it were whole. There is no
  delete, prune or kill key — `job(action="prune")` is still the way to remove anything.
- **It never wakes the agent.** Opening the overlay sends no message, triggers no turn and calls
  no tool, so browsing costs zero tokens. That is deliberately the opposite of what a *completion*
  does one section up, and the two are not inconsistent: a finished job is a result nobody is awake
  to read, so it wakes the agent; you looking through history is not a result, and the agent has no
  reason to know you did it.

`↑`/`↓` move, `Enter` opens a job, `o` cycles stdout → stderr → cmd, `K`/`J` scroll the detail
pane, `r` refreshes, `Esc` closes. Those first movements are spelled exactly as the sub-agent
package's fleet inspector spells them, so the `fleetKeybindings` block in `config/subagent.json`
retunes `/jobs` and `/subagents-fleet` together — one place to rebind if your terminal swallows
`PgUp`/`PgDn`. The three jobs-only actions (`Enter`, `o`, `←`) are bound to keys no terminal
intercepts and need no such hatch.

Outside the TUI the command says so and points at `job(action="list")` rather than failing.

## Cost

One directory per job, on disk, until pruned. `session_start` auto-prunes finished jobs older than
`PI_JOBS_PRUNE_HOURS` (default 168, i.e. 7 days) on every session, so a store nobody remembers to
clean up does not grow without bound. `job prune` is still a real command for pruning by hand
sooner than that.

## Related
[bash](bash.md) · [big-results](big-results.md) · [teammates](teammates.md) · [dispatch](dispatch.md) ·
[Configuration layout](../getting-started/config-layout.md#runtime-state)
