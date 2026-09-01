# `loader-clock` — the loader says how long and what it is doing

One job: while a turn is open, the top-level loader shows elapsed time and the current activity
phase — `Working… 2m14s · streaming`, or `Working… 18s · tool: read` the instant a tool call opens
— instead of a bare `Working...` that reads the same at ten seconds and at ten minutes.

## Why this is not `thinking-indicator`

[thinking-indicator](thinking-indicator.md) deliberately avoids the loader's text channel — its own
docstring says using it "would say the level in words and cost a line of prose on every turn". This
module needs exactly that channel, for a different axis (elapsed time and activity, not thinking
level). `setWorkingIndicator` (frames) and `setWorkingMessage` (text) are independent fields on the
same loader, so the two modules never touch each other's state.

## The ticker

A static `setWorkingMessage` call does not animate. A `setInterval`, `unref()`d so it can never hold
the process open, repaints the message once a second while a turn is open, starts at `turn_start`,
and stops the instant the turn ends. `session_shutdown` clears it unconditionally as a safety net,
and `session_start` resets any turn state a stale event ordering could otherwise carry into a
replaced session.

## Where it does nothing

- **Outside the TUI.** Same guard as `thinking-indicator`: `mode === "tui"`. In `rpc`, `print` and
  `json` modes the module touches nothing and starts no ticker.
- **On shutdown or turn end.** The default loader text is handed back, so custom text never outlives
  the turn or the session.

## Related

- [thinking-indicator](thinking-indicator.md) — the loader's other, independent channel (frames, not
  text).
