# Generated and locked files

Four files in `config/` are **records, not settings**. They exist so that a check can compare
reality against something written down. Editing one to make a check pass removes the check without
fixing what it found — which is strictly worse than the finding, because now nothing is watching.

They are listed here so you can recognise them and leave them alone.

---

## `config/api-surface.lock.json`

A probe record of the PI extension API this repository was built against: package version, binary
version, the `.d.ts` files read, and the full list of events, hooks and context methods that
existed at probe time.

```json
{
  "probeVersion": 1,
  "generatedAt": "2026-08-07T…",
  "pi": { "packageVersion": "0.84.4", "binaryVersion": "0.84.4", … },
  "events": ["after_provider_response", "agent_end", "agent_settled", …]
}
```

**Why it exists:** this harness depends on several PI behaviours that are real but undocumented,
and on the exact set of events the extension API exposes. When you upgrade PI, the difference
between this file and a fresh probe is the list of things that might have moved.

**Regenerate it, do not edit it.** An entry you add by hand asserts that an event exists; if it does
not, you have converted a startup error into a handler that never fires.

---

## `config/packages.lock.json`

Every adopted community package pinned by **version and tarball sha256**, with its licence,
repository, review date, adoption status and the role it plays.

```json
{
  "name": "pi-subagents",
  "version": "0.41.0",
  "tarball": "https://registry.npmjs.org/pi-subagents/-/pi-subagents-0.41.0.tgz",
  "sha256": "f433f7b1…",
  "license": "MIT",
  "reviewed": "2026-08-06",
  "status": "adopted",
  "role": "sub-agent runtime",
  "vendor": false
}
```

`bin/pi-check` rules `PC-09`, `PC-18` and `PC-19` assert a **three-way agreement** between
`package.json`, this file, and what is actually installed in `node_modules/`. `/doctor`'s `D-08`
reports a mismatch as a warning during a session.

**What breaks if you edit it:** bumping a version here without installing that version makes the
check pass while the tree is unchanged. The sha256 is the part that matters — it is what makes
"the package I reviewed" and "the package that is installed" the same claim rather than two
hopeful ones.

To change a package version: change `package.json`, install, recompute the hash, update this file.
In that order.

---

## `config/tools.declared.json`

The declared tool roster that `/doctor`'s `D-01` consults **in addition to** the live
`pi.getAllTools()` list.

```json
{
  "tools": [
    { "name": "expand_result", "source": "custom", "module": "extensions/big-results/index.ts" },
    { "name": "subagent",      "source": "package", "package": "pi-subagents" },
    { "name": "web_fetch",     "source": "package", "package": "pi-web-access" }
  ]
}
```

`D-01` checks that every tool name your instruction text mentions actually exists. Some legitimately
do not appear in the live roster at the moment it runs — a package tool whose provider is present
but uncredentialed this session, or a tool named in prose before its extension loaded. This file is
the allowlist for those.

Core PI built-ins (`bash`, `read`, `edit`, `write`, `glob`, `grep`, …) are deliberately **not**
listed: they are always in `pi.getAllTools()`, and `D-01` checks that live roster first.

**What breaks if you edit it:** adding a name here does not create a tool. It tells `D-01` to stop
reporting that the tool is missing — so the next time you typo a tool name in an agent definition,
nothing catches it. Add an entry only when you have a real tool whose absence from the live roster
you understand.

---

## `config/pi-release.lock`

A record of the pinned PI release. Same principle: it is what an upgrade is diffed against.

---

## The rule

If a file has `lock`, `declared` or a `generatedAt` timestamp in it, the question to ask is not
"what should this say?" but "**what is it describing, and has that changed?**". Fix the thing being
described, then regenerate.

## Related

- [Configuration index](index.md) — the files you *should* edit
- [`settings.json`](settings.md#resource-paths) — the `packages` array `packages.lock.json` tracks
- [doctor](../extensions/doctor.md) — `D-01` and `D-08`
- [Third-party components](../reference/third-party.md)
