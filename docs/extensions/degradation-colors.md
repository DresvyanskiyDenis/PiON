# `degradation-colors` — reserve amber/red exclusively for degradation

Every block in the TUI is a dark slab in a slightly different tint, and semantic color is spent on
syntax highlighting and tool names rather than on state. A degrading session looks exactly like a
healthy one — the operator's only clue is the cost figure. A provider retry, a provider failure —
grey blocks like everything else.

## The rule

Reserve `error` (red) and `warning` (amber) exclusively for degradation: provider retry, provider
failure, and (future hooks, not yet wired) context-preflight refusal, a turn ending
`error`/`aborted`, cache-miss re-bill, a tool or lane past its duration threshold. A three-second
glance should distinguish "this session is fine" from "this session is on fire" — which only works
if amber/red never mean anything else.

## What this module does today

Registers custom entry renderers for `provider_retry` (amber) and `provider_failure` (red) — the
two degradation states with the most session entry data available right now — and colors the whole
report red or amber, prefixing the first line with a marker glyph (`🔴` failure, `⚠️` retry).

## Why a whole-block color, not a one-line summary

`extensions/lib/provider-error.ts`'s `surfaceProviderFailure` files these entries as
`{ classified: string }` — the same multi-line report `formatProviderFailure()` already writes to
stderr, not a structured object with its own `provider`/`model`/`class` fields. Reformatting that
report into a one-line header here would either duplicate `formatProviderFailure`'s field selection
by hand — a second copy that drifts the first time that function grows a field — or parse its own
rendered text back apart, which is more fragile than the string it starts from. Coloring the report
as a whole keeps this module honest about what it actually has: one already-composed block whose
only missing property is a color.

## Related

- [loader-clock](loader-clock.md) — the other module in the same presentation bucket.
