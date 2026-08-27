# `thinking-indicator` — the spinner tells you how hard it is thinking

One job: while the model is streaming, the working indicator shows the current thinking level, in
the level's own colour and at a matching glyph height.

```
▁  off        ▄  medium      ▇  max
▂  minimal    ▅  high
▃  low        ▆  xhigh
```

## Why this is not a new signal

PI already renders the thinking level — it paints the **editor's border** with
`theme.getThinkingBorderColor(level)`. That is one cell wide, at the edge of the frame, and it is
the only place the level appears while a turn is running, which is the moment it matters: the
difference between a level that costs a few hundred reasoning tokens and one that costs tens of
thousands is not visible in the row you are actually looking at, where the spinner turns in the
accent colour no matter what.

This module puts the same signal on the spinner. Deliberately the **same** colour, read from the
live theme's own `getThinkingBorderColor` rather than a second palette — if you change `/theme`,
both move together, and the border and the spinner never disagree.

It also adds a channel that is not colour. The glyph's height on `▁▂▃▄▅▆▇█` is indexed by the
level's rank, so the level is legible without colour vision, in a screenshot, or through a terminal
that has quantised the palette down to something coarse.

## What it does not own

The animation. `pi-tui`'s `Loader` holds the interval, restarts it whenever the indicator changes,
and clears it in `dispose()`; interactive mode builds a fresh indicator for each stream from
whatever options were last set. This module sets one options object and schedules nothing at all —
no timer, no component, no subscription of its own.

That is the difference between a claim and a fact, so it is a test rather than a sentence in a
docstring: `test/thinking-indicator.test.ts` counts every `setInterval` and `setTimeout` call across
a session start, seven level changes and a shutdown, and requires the count to be zero.

## Timing

Two frames, 280 ms apart. PI's own spinner runs at 80 ms because it is a ten-frame rotation and
reads as motion; a two-frame alternation at that rate reads as a flicker. 280 ms sits at the slow
end of the 150–300 ms band that keeps a repeating state change perceptible without becoming
something you have to look away from, and the test holds the interval inside that band rather than
pinning the one number.

## Where it does nothing

- **Outside the TUI.** `hasUI` is true in RPC mode as well, where there is no loader to configure,
  so the guard is `mode === "tui"` — the condition PI's own API documentation names for
  terminal-only UI. In `rpc`, `print` and `json` modes the module touches nothing.
- **With no theme installed.** The frames render unstyled instead of throwing. The height channel
  does not depend on colour, so the level still reads.
- **On shutdown.** The default spinner is handed back, so custom frames never outlive the module
  that set them.

## Related

- [Themes](../configuration/themes.md) — where the seven `thinking*` colours are defined.
