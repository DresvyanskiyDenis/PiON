# `bash` — timeout ceiling, default, and truncation hints

Bash is the majority of all tool calls, and PI's `timeout` parameter is **optional with no
default**. One `timeout`-less `ssh` or container build hangs the agent with no bound.

Configured by [`config/bash-timeouts.json`](../configuration/tools.md#bash-timeoutsjson).

## The units trap

!!! danger "PI's bash `timeout` is SECONDS, not milliseconds"
    Verified against 0.84.0's `dist/core/bash-executor.js`: `resolveTimeoutMs = timeout * 1000`, and
    the tool's own schema documents the field as *"Timeout in seconds (optional, no default
    timeout)"*.

    An early spec skeleton for this module used millisecond constants (`60 * 60_000`, `120_000`) and
    clamped with `input.timeout > CEILING_MS`. Applied literally to a seconds field, that "ceiling"
    lets a **~41-day** timeout through and that "default" is **~33 hours** — the opposite of both
    requirements.

    This module works in seconds throughout, and `config/bash-timeouts.json`'s keys are named
    accordingly (`defaultTimeoutSeconds`, `ceilingSeconds`).

## What it enforces

| | |
|---|---|
| **A ceiling** | The maximum a model may request. Ours, not PI's — PI's own limit is bounded only by `setTimeout`'s 32-bit range, about 24.8 days |
| **A default** | Injected when the model omits `timeout` |
| **A tail hint** | On truncated output, tells the model how to retrieve the rest instead of re-running the command |

## Defence in depth: the default is injected twice

The adopted timeout package also injects a default — its handler is 28 lines with no upper-bound
check at all, and the ceiling is explicitly not its job. PI calls every registered `tool_call`
handler across every loaded extension on the **same mutable event object**, in registration order.
Nothing in this tree controls whether the package registers before or after this module, so both
inject the same default and the outcome is identical either way.

Duplicated deliberately. The alternative is a behaviour that depends on load order nobody controls.

## Truncation

`maxLines` (2000) and `maxBytes` (50 KiB), whichever is hit first. The cut takes the **tail**, which
is usually where the interesting part is — pipe through `tail`, `rg` or `jq` rather than raising the
limits. For genuinely large results, [`big-results`](big-results.md) hands back a re-expand handle.

## Related
[`bash-timeouts.json`](../configuration/tools.md#bash-timeoutsjson) · [big-results](big-results.md) ·
[jobs](jobs.md) for work that outlives a tool call
