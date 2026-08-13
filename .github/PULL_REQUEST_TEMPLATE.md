<!-- Keep this short. Delete any section that does not apply. -->

## What and why

<!-- One paragraph. What changes, and what problem it solves. -->

## Files touched

<!-- e.g. config/guard.json, extensions/hooks/index.ts, docs/configuration/guard.md -->

## Checks

- [ ] `./bin/pi-check --all` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Documentation for the changed behaviour ships **in this pull request**

## If this touches configuration

- [ ] I changed the tracked template (`config/*.default.json`), not only the generated file
- [ ] The shipped default is documented, and so is what breaks if it is set wrongly
- [ ] I did not document a value I have not read out of the file or the code

## If this touches the load order

- [ ] `extensions/index.ts` still satisfies its stated invariants: `guard` first, `trust` second,
      `hooks` after `guard`, `dispatch` before `teammates`/`worktree`/`jobs`, `doctor` last

## If this changes a safety posture

<!-- Say plainly what an attacker or an accident can do after this change that it could not before.
     "Nothing" is a valid answer; leaving it blank is not. -->
