/**
 * `EXT-16` — the lint half ("Warns once per skill whose
 * `allowed-tools` frontmatter cannot be honoured; generates the 20-row portability matrix"). No
 * wave spec exists for this item ("write each spec in the session
 * that builds it, ... commit the spec with the code" — this docstring is that spec).
 *
 * **The one fact this module is built on, verified against the pinned 0.84.0 package, not
 * assumed:** `dist/core/skills.js`'s frontmatter reader parses exactly three fields —
 * `name`, `description`, `disable-model-invocation` (grepped directly; see the module's own
 * `frontmatter.name || parentDirName` / `frontmatter.description` / `frontmatter["disable-model-invocation"]`
 * call sites). `allowed-tools` — the Claude Code convention the shim half's sibling modules
 * (`skills-env.ts`, `skill-mask.ts`) never touch — is read by nothing in the package, anywhere.
 * `grep -rl "allowed-tools\|allowedTools"` across every `@earendil-works` package's `dist/` returns no
 * matches. So there is no enforcement half to build: a skill's `allowed-tools` line is inert
 * prose the moment PI loads it. `REQ-EXT-16`'s inversion (fail closed on
 * a rule match, fail open on our own bug) does not apply here either: there is no rule to match
 * against, only a fact to surface. This module's entire job is the warning, once per skill, so
 * that fact is loud instead of silently assumed by whoever wrote the frontmatter.
 *
 * **Why this is a standalone module and not folded into `EXT-10`'s `doctor.ts`/`checks.ts`.**
 * `EXT-10` was built and reported complete before this item was scheduled; its files are
 * unowned by this task and it is depended on, not modified (`EXT-16`'s lint half depends on
 * `EXT-10`, not the reverse). Editing `doctor/types.ts`'s
 * `CheckId` union or `checks.ts` would touch a completed item's files for a warning that has a
 * different lifecycle (`session_start`, fire-and-forget) from `/doctor`'s on-demand report. This
 * module registers independently, the same shape every wave-1 module uses
 * (`export const id` / `export function register(pi)` contract), and is
 * composed into `extensions/index.ts`'s `ORDER` array by integration like any other module.
 *
 * **The matrix.** `docs/skills-portability.md` already carries a hand-authored 20-row matrix
 * from `W1-CONTENT` (tier / placement / content-port status). This module does not replace that
 * — it is a different axis (frontmatter enforceability, not port status) and that file is not
 * owned by this task either. `scripts/gen-skills-lint-matrix.mjs` (owned by this item) appends a
 * generated section to the same doc between two HTML comment markers, so it is regenerable
 * (`node scripts/gen-skills-lint-matrix.mjs`) rather than hand-maintained, per this item's own
 * task text — re-running it after a skill's frontmatter changes updates the table without a
 * human re-deriving it by eye.
 */
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { emitNotice } from "./lib/announce.ts";
import { describeError, surfaceOnce } from "./lib/once.ts";
import { repoRoot } from "./lib/paths.ts";

export const id = "skills-lint";

/**
 * Mirrors `doctor/declared.ts`'s `SKILL_ROOTS` deliberately (not imported — see module
 * docstring on why this stays independent of `EXT-10`'s files). `skill-bundles/` is excluded
 * for the same reason `declared.ts` excludes it: a bundle's nested members are never addressed by
 * name directly, only through a router skill that dispatches to them by path.
 *
 * **One root, since the bucket collapse.** This used to read
 * `["skills", "skills-work", "skills-private"]`. The three-way split looked like a privacy
 * boundary and was not one: only `skills-private/` was git-ignored, and the other two loaded
 * because `skill-mask.ts` contributed them at runtime — which is why neither ever appeared in
 * `config/settings.json`'s `skills` array. One root, declared once in settings, is the honest
 * shape, and this array is a tuple only so `SkillTier` keeps naming something.
 */
export const SKILL_ROOTS = ["skills"] as const;
export type SkillTier = (typeof SKILL_ROOTS)[number];

export interface SkillFrontmatterInfo {
  readonly name: string;
  readonly tier: SkillTier;
  readonly path: string;
  readonly declaresAllowedTools: boolean;
  readonly allowedTools: readonly string[];
  /** Set when `parseFrontmatter` itself threw — see `discoverSkillFrontmatter`'s docstring for
   *  why a corrupt `SKILL.md` degrades to a finding instead of aborting the whole scan, and why
   *  this is a real, independently-observed bug rather than a hypothetical this module guards
   *  defensively against. */
  readonly parseError?: string;
}

/**
 * `allowed-tools` shows up in the wild as either a YAML array or a comma-separated string
 * (`allowed-tools: Read,Write,Edit,WebFetch,WebSearch`). No skill in this tree declares it — the
 * tree ships no skills at all — so this parser has no live input in a fresh clone. It stays because the field arrives with any skill copied in
 * from Claude Code, and the warning it feeds is the whole point of `EXT-16`: PI 0.84.0 parses
 * exactly `name`, `description` and `disable-model-invocation`, so an `allowed-tools` line is
 * inert prose that reads as enforcement. Both shapes are accepted; anything else
 * (a bare scalar with no comma, an object) degrades to an empty list rather than throwing — a
 * malformed field is `checks.ts`/`/doctor`'s territory, not this module's.
 */
export function parseAllowedTools(raw: unknown): readonly string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
}

/**
 * Scans the skill root for `SKILL.md` files and reads each one's frontmatter. A missing root is
 * not an error — a fresh clone carries no `skills/` directory at all, the same tolerance
 * `doctor/declared.ts` uses for the identical layout.
 *
 * A `SKILL.md` that exists but fails to parse as YAML frontmatter is recorded as a
 * `parseError` entry rather than thrown — **empirically necessary, not a defensive guess**: a
 * real skill was found whose unquoted `description:` contained a colon inside a plain scalar
 * ("`Default output dir: ...`"), which makes PI's own `parseFrontmatter` throw `YAMLParseError`,
 * verified by calling the real export from the pinned package directly. Such a skill likely fails
 * PI's own frontmatter read at session start too — a bug this module did not introduce and does
 * not own the fix for, but one bad file must not blind the scan to every other skill.
 */
export function discoverSkillFrontmatter(root: string): readonly SkillFrontmatterInfo[] {
  const out: SkillFrontmatterInfo[] = [];
  for (const tier of SKILL_ROOTS) {
    const dir = join(root, tier);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries.toSorted()) {
      const skillMdPath = join(dir, entry, "SKILL.md");
      try {
        if (!statSync(skillMdPath).isFile()) continue;
      } catch {
        continue; // entry is not a skill directory (no SKILL.md) — not an error
      }
      let raw: string;
      try {
        raw = readFileSync(skillMdPath, "utf8");
      } catch (err) {
        throw new Error(`skills-lint: cannot read ${skillMdPath}: ${describeError(err)}`);
      }
      let frontmatter: Record<string, unknown>;
      try {
        frontmatter = parseFrontmatter(raw).frontmatter as Record<string, unknown>;
      } catch (err) {
        out.push({
          name: entry,
          tier,
          path: skillMdPath,
          declaresAllowedTools: false,
          allowedTools: [],
          parseError: describeError(err),
        });
        continue;
      }
      const allowedTools = parseAllowedTools(frontmatter["allowed-tools"]);
      out.push({
        name: typeof frontmatter.name === "string" ? frontmatter.name : entry,
        tier,
        path: skillMdPath,
        declaresAllowedTools: allowedTools.length > 0,
        allowedTools,
      });
    }
  }
  return out;
}

export interface SkillLintFinding {
  readonly skillName: string;
  readonly tier: SkillTier;
  readonly path: string;
  readonly allowedTools: readonly string[];
  readonly message: string;
}

/**
 * The one rule this lint half has: every skill declaring `allowed-tools` is unenforced by PI
 * (see module docstring — verified against the pinned package, not a guess), so every one of
 * them is a finding. There is no filtering against "does the named tool even exist" — naming a
 * real tool is exactly as unenforced as naming a fictional one, so that distinction would be
 * noise, not signal, for what this warning is actually about.
 */
export function lintAllowedTools(skills: readonly SkillFrontmatterInfo[]): readonly SkillLintFinding[] {
  return skills
    .filter((s) => s.declaresAllowedTools)
    .map((s) => ({
      skillName: s.name,
      tier: s.tier,
      path: s.path,
      allowedTools: s.allowedTools,
      message:
        `skill "${s.name}" (${s.tier}) declares allowed-tools (${s.allowedTools.join(", ")}) in its ` +
        `frontmatter, but PI does not read or enforce this field — verified against ` +
        `dist/core/skills.js in the pinned @earendil-works/pi-coding-agent 0.84.0: only name, ` +
        `description and disable-model-invocation are parsed. This is advisory text for a human ` +
        `or a future model turn, not an access restriction — do not rely on it as one.`,
    }));
}

/**
 * A stronger relative of `lintAllowedTools`: a skill whose frontmatter does not even parse has
 * *nothing* honoured, `allowed-tools` included, and PI's real loader hits the same throw at
 * discovery time (see `discoverSkillFrontmatter`'s docstring). Reported separately because the
 * remedy is different — fix the YAML, not "PI doesn't support this field".
 */
export function lintParseErrors(skills: readonly SkillFrontmatterInfo[]): readonly SkillLintFinding[] {
  return skills
    .filter((s): s is SkillFrontmatterInfo & { parseError: string } => s.parseError !== undefined)
    .map((s) => ({
      skillName: s.name,
      tier: s.tier,
      path: s.path,
      allowedTools: [],
      message:
        `skill "${s.name}" (${s.tier}) at ${s.path} has frontmatter that fails to parse ` +
        `(${s.parseError}) — PI's own loader hits the same error, so this skill likely fails to ` +
        `load at all, not merely fails to honour allowed-tools. Fix the YAML in its frontmatter.`,
    }));
}

export function register(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    try {
      const skills = discoverSkillFrontmatter(repoRoot());
      const findings = [...lintAllowedTools(skills), ...lintParseErrors(skills)];
      for (const f of findings) {
        surfaceOnce(ctx, `skills-lint:allowed-tools:${f.tier}/${f.skillName}`, () => {
          // One channel, not both. The two used to disagree on the prefix as well as fire twice:
          // stderr got "[pi-config] skills-lint: …", the TUI got "Warning: skills-lint: …", which
          // read as two separate findings. `lib/announce.ts` carries the argument.
          emitNotice(ctx, `[pi-config] skills-lint: ${f.message}`, "warning");
        });
      }
    } catch (err) {
      // Fail open: a bug in this lint (a malformed SKILL.md, an unreadable path) must cost its
      // own warning, never the session — this module has no gate to refuse anything with, unlike
      // doctor.ts's D-06.
      surfaceOnce(ctx, "skills-lint:handler-error", () => {
        process.stderr.write(`[pi-config] skills-lint: session_start handler failed — ${describeError(err)}\n`);
      });
    }
  });
}
