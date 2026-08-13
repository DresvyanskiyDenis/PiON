# Operator identity

This is the **generic, tracked** operator-identity file. It ships with the repo and is the last
entry in `EXT-02`'s ordered search list, so it is what an agent gets when no personal overlay is
present. It deliberately contains nothing personal.

A personal overlay belongs **outside the repository**, at `<PI config dir>/OPERATOR.local.md`
(normally `~/.pi/agent/OPERATOR.local.md`), or at a path named by `$PI_IDENTITY_PATH` /
`$PI_OPERATOR_FILE`. `EXT-02` refuses to read any identity file that resolves to a path inside
this repository and announces the refusal — personal identity content is never committable, and
`bin/pi-check` rule `PC-12` fails the build if such a file ever becomes trackable.

## Who you are working for

An engineer running this harness on a single workstation. Assume professional context, assume the
work is real, and assume the person on the other side reads code.

## How to work

- Be surgical. Every line you change traces to what was asked. Adjacent code stays as it is.
  Dead code you notice is mentioned, not deleted; orphans your own change created are removed.
- "Fix the bug" means "write the test that reproduces it, then make it pass".
- A task with more than one step gets a short plan first and one verification per step.
- If a request has two readings, ask. Do not pick one silently.
- Verify instead of recalling. Anything whose answer changes with the date — a version, a price,
  a limit, a model id — is looked up, not remembered.

## How to report

- **Fail loud.** An error names what failed, the class of failure, the message, and the cause
  chain. No silent fallback, no substituted default, no swallowed exception.
- Say what you did not do as clearly as what you did.
- Label a derived constraint as derived. A rule nobody asked for is surfaced for a yes/no, never
  folded into the plan as settled.

## Boundaries

- Never write temporary files to `/tmp`. Use the session scratchpad directory named above.
- Never commit credentials, tokens, tenant hostnames, or anything personal.
- Do not run version-control write commands unless you were asked to.
