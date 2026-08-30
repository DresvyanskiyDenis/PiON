# The pinned lead model

`extensions/lead-model/` — one lead model per project, held for the length of a work stream and
changed only as a recorded act.

## Why

A session that changes its lead model repeatedly inside one investigation cannot answer the only
question the investigation is about. Models differ in context window, in structured-output
behaviour and in failure mode, so a lead that moves while you debug makes *"is this the model or is
this the code"* unanswerable and every result before the switch incomparable with every result
after it. The bill arrives days later, when someone reads the transcript back and cannot say which
model produced which half of the evidence.

Pinning does not make a model better. It makes the results before and after a point comparable.

## The file

`<project>/.pi/lead-model.json`, a sibling of the `<project>/.pi/settings.json` PI already reads.
Resolved as `join(cwd, ".pi", "lead-model.json")` with **no walk up the tree**: a pin a
subdirectory silently inherits from three levels up is a pin nobody can see from where they are
standing. `PI_LEAD_MODEL_JSON` overrides the whole resolution, for tests.

```json
{
  "version": 1,
  "tier": "strong",
  "since": "2026-08-31",
  "reason": "why this project holds this lead, in at least 12 characters"
}
```

`tier` names a [`routing.json` tier](routing.md#tiers), never a literal model id — `config/README.md`
rule 3. `reason` is required and has a length floor: a pin with no reason is a preference, and the
next session cannot tell the two apart.

An absent file means an unpinned project, which is silent and is the normal state. A malformed file
is announced at `error` level and pins nothing; it is never quietly treated as an absent one.

## What it does

| When | What happens |
| --- | --- |
| `session_start` | The pinned tier is resolved and selected with `pi.setModel()`, after [`path-defaults`](../extensions/path-defaults.md) has applied the install-wide default. The tier's `thinkingLevel` goes with it. |
| any `model_select` away from the pin | The pin is re-selected and the switch is announced at `error` level, naming what was undone and the command that would make it stick. |
| `/lead-model` | Reports the pin, and whether it is enforced this session. |
| `/lead-model <tier> <why>` | Rewrites the pin file, switches the session onto the new tier, and writes the change plus your reason to the session facts file. |

It is a **revert**, not a block, because PI offers no seam for a block: `ModelSelectEvent` carries
no result type, unlike `tool_call`'s `{ block, reason }`. `pi.setModel()` is the only lever, so the
module puts the model back and says so. A revert is strictly better than the silent no-op the
alternative would be: you see the model you chose, see it snap back, and read one sentence naming
the sanctioned path.

Every selection source is treated alike, including PI's own restore when a session is resumed onto
whatever model it was last using. A work stream resumed on a drifted model is exactly the case this
exists for, so a restore is not exempt.

## Changing the pin

```
/lead-model light this stream is mechanical edits and does not need the strong lead
```

The reason is neither optional nor decorative. It goes into the pin file, where a diff shows it,
and is appended to the session facts file through the [`fact`](../extensions/compaction.md#the-fact-tool)
writer, so it survives every compaction: a later turn reading a strange result learns that the lead
moved, when, and why.

There is deliberately no `/lead-model off`. Unpinning means editing or deleting the file, which is
a change in the working tree and shows up in a commit. An unpin verb would be one keystroke away
from having no pin at all — the same failure as an acknowledgement flag you set once and never
unset.

## When the pin stands down

If the pinned tier resolves to a model this install cannot select — not in the registry, or no
credential for its provider — the pin is announced as **not enforced** and the module does nothing
else for that session. Holding a session on a model it cannot reach would trap it rather than
protect it. The announcement is at `error` level, so an unenforced pin is never a quiet one.

## Gate

`PC-30` checks this repository's own committed pin: the shape, and that its tier still exists in
the routing table. A tier renamed out from under a pin leaves a syntactically perfect file that
silently pins nothing — worse than no pin, because the documentation goes on saying the lead is
held.

## Related

- [`config/routing.json`](routing.md) — where the tier names come from
- [`path-defaults`](../extensions/path-defaults.md) — the install-wide default this pin overrides
- [`compaction`](../extensions/compaction.md) — the facts file a change is recorded in
