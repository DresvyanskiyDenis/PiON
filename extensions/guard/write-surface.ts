/**
 * The write surface: which paths a command line actually MUTATES, and whether they lie inside the
 * sandbox.
 *
 * ## Why this exists
 *
 * The guard's original outermost layer was a curated list of *program names* (`bash-allowlist.ts`).
 * A name list polices the wrong axis. It cannot distinguish `sed -n 1,20p file` from
 * `sed -i s/x/y/ /etc/hosts`, it says nothing about `> /etc/hosts`, and it was already admitting
 * `python`, `node`, `npx`, `make` and `docker` — five programs that can express any write at all.
 * So the name list never was the boundary; it only felt like one, and it cost 24 of 33 measured
 * subagent runs.
 *
 * What must actually hold is the *write surface*: an agent may mutate what is inside the sandbox
 * and must not mutate what is outside it. That is a property of the **form** of a command — which
 * path is being written and by what construct — not of the name of the program expressing it. This
 * module is that analysis, and `gates/write-surface.ts` is the gate that enforces it.
 *
 * ## The two questions
 *
 * 1. `writeTargets(segment)` — *what does this segment write?* Redirections, `tee`, in-place edits
 *    (`sed -i`, `perl -i`, `yq -i`), `find -delete` / `find -exec rm`, `curl -o`, `wget -O`,
 *    `tar -C`, `unzip -d`, `dd of=`, and the ordinary mutating coreutils. Wrapper peeling means
 *    `sudo`, `env`, `xargs`, `timeout` and `nice` reach the same rules as the bare program
 *    (`shell.ts#WRAPPERS`), so `… | xargs rm -rf ~/Documents` is analysed as `rm -rf ~/Documents`.
 * 2. `classify(word, cwd)` — *where does that path land?* `inside` the sandbox, `outside` it, or
 *    `unknown` because it begins with a variable whose value only exists at runtime. "Inside" is a
 *    prefix test against `sandboxRoots()` plus one git question: a linked worktree of the session's
 *    own repository is the project too, however unrelated its path looks (`lib/same-repo.ts`).
 *
 * ## What it deliberately does NOT try to do
 *
 * It does not look inside an interpreter. `python3 -c …`, `node -e …`, `awk '{print > "/etc/x"}'`
 * and a `make` target can all write anywhere, and no static reading of a command line can see it.
 * That gap is not created here — it was already open, because `python`, `node`, `npx`, `make` and
 * `docker` shipped on the very first allowlist. The honest statement of coverage is: *forms
 * expressed on the command line, yes; forms expressed inside a program's own argument text, no.*
 * The answer to the second half is OS-level containment (`pi-sandbox`), which is not wired.
 */
import { homedir, tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { stateRoot } from "../lib/paths.ts";
import { sameRepo } from "../lib/same-repo.ts";
import type { Segment } from "./shell.ts";
import { program } from "./shell.ts";
import { expandTilde } from "./targets.ts";

/** A path this segment writes to, with the construct that made it a write. */
export interface WriteTarget {
  /** The literal word, as it appeared on the command line. */
  readonly word: string;
  /** The form, in the model's own terms: `redirection (>)`, `sed -i`, `find -delete`, … */
  readonly form: string;
}

/**
 * `inside`  — resolves under a sandbox root.
 * `outside` — resolves to a concrete path that does not.
 * `unknown` — begins with a variable whose value this process cannot know, so neither of the above
 *             can be established. Treated as `outside` by the gate: an unresolvable write target is
 *             the one case where guessing "probably fine" is the expensive guess.
 */
export type Location = "inside" | "outside" | "unknown";

export interface LocatedWrite extends WriteTarget {
  readonly location: Location;
  /** The absolute path the word resolved to, when it resolved at all. */
  readonly resolved?: string;
}

/**
 * The sandbox: the session working directory, the OS scratch directory, and this harness's own
 * state root (which is where `AGENTS.md`'s per-session scratchpad lives).
 *
 * `ctx.cwd` and not a configured project root, because the bash tool has no `cwd` parameter and
 * always runs in the session working directory — that IS the boundary the model operates in. The
 * same fact is why `cd` stays refused in both directions (`escalation.ts#NEVER_RELAXED_PROGRAMS`):
 * if a command could move the working directory, it could move this boundary with it.
 */
export function sandboxRoots(cwd: string): string[] {
  const roots = [cwd, tmpdir()];
  try {
    roots.push(stateRoot());
  } catch {
    // A distribution without a resolvable state root simply has one root fewer. Stricter, never
    // looser, which is the only direction a failure here may resolve in.
  }
  return roots.filter((root) => typeof root === "string" && root.length > 0);
}

/**
 * Sinks that are not files. `-` is stdout for `curl`/`wget`/`tar`, and `/dev/null` and friends
 * consume output without mutating anything a later command could read back.
 * `/dev/sd*`, `/dev/nvme*` and `/dev/disk*` are deliberately absent: those are raw block devices,
 * they are catastrophic, and `DB-REDIR-DISK` / `DB-DD-DISK` refuse them with no override at all.
 */
const DEV_SINKS: ReadonlySet<string> = new Set([
  "-",
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
]);

/** Variables whose value is a scratch directory by definition, set or not. */
const SCRATCH_VARS: ReadonlySet<string> = new Set(["TMPDIR", "TMP", "TEMP"]);

/** `$FOO/bar`, `${FOO}/bar` — but only at the very start, where it decides the whole location. */
const LEADING_VAR = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(?=$|\/)/;

/**
 * Where a write target lands.
 *
 * Variables are expanded from a **fixed table**, never from `process.env` at large: a guard whose
 * verdict depends on ambient environment is a guard that cannot be reasoned about or tested.
 * `$TMPDIR`/`$TMP`/`$TEMP` are scratch by definition, `$PWD` is the session directory, `$HOME` is
 * the real home directory — and anything else, or a `$` anywhere further along the path, is
 * `unknown`. The way out of an `unknown` is to write the literal path, which the refusal says.
 */
export function classify(word: string, cwd: string): { location: Location; resolved?: string } {
  if (word.length === 0) return { location: "inside" };
  if (DEV_SINKS.has(word) || word.startsWith("/dev/fd/")) return { location: "inside" };

  let path = word;
  const lead = LEADING_VAR.exec(path);
  if (lead) {
    const name = lead[1]!;
    const rest = path.slice(lead[0].length);
    if (SCRATCH_VARS.has(name)) return { location: "inside" };
    if (name === "PWD" || name === "INIT_CWD") path = `.${rest}`;
    else if (name === "HOME") path = `${homedir()}${rest}`;
    else return { location: "unknown" };
  }
  // A variable anywhere else can still contain `../..`, so the resolved form would be a fiction.
  if (path.includes("$")) return { location: "unknown" };

  let absolute: string;
  try {
    absolute = resolve(cwd, expandTilde(path));
  } catch {
    return { location: "unknown" };
  }
  for (const root of sandboxRoots(cwd)) {
    if (contains(root, absolute)) return { location: "inside", resolved: absolute };
  }
  // The prefix test has just said "outside". It is wrong for a case this harness is expected to
  // work in: a linked git worktree of the SAME repository sits at a path sharing no prefix with the
  // session directory, so ordinary work on another branch of the project reads as a write into a
  // stranger's tree. Ownership is git's answer (`--git-common-dir`), not the string's — see
  // `lib/same-repo.ts`. Asked only here, on the path the cheap test already missed.
  if (sameRepo(cwd, absolute)) return { location: "inside", resolved: absolute };
  return { location: "outside", resolved: absolute };
}

function contains(root: string, path: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Every write target of a segment, located. */
export function locateWrites(segment: Segment, cwd: string): LocatedWrite[] {
  return writeTargets(segment).map((target) => ({ ...target, ...classify(target.word, cwd) }));
}

// ---------------------------------------------------------------------------------------------
// Form extraction
// ---------------------------------------------------------------------------------------------

/** Programs whose every non-flag operand is a path they mutate. */
const OPERANDS_ARE_WRITTEN: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "truncate",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "chgrp",
  "tee",
  "gzip",
  "gunzip",
  "bzip2",
  "xz",
]);

/** Programs whose LAST non-flag operand is the destination; the earlier ones are sources. */
const LAST_OPERAND_IS_WRITTEN: ReadonlySet<string> = new Set([
  "cp",
  "mv",
  "ln",
  "install",
  "rsync",
  "scp",
]);

/**
 * Programs that are read-only until given an in-place flag, which is exactly the shape a
 * program-name allowlist cannot see. `-i` is matched as a letter inside a single-dash cluster, so
 * `perl -pi -e …` and `sed -Ei …` are caught as well as the bare `-i`.
 */
const IN_PLACE_PROGRAMS: ReadonlySet<string> = new Set(["sed", "perl", "ruby", "gawk", "yq"]);

/** `find` predicates that write a named file. The value is the next word. */
const FIND_FILE_ACTIONS: ReadonlySet<string> = new Set([
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

/** `find` predicates that hand the matched paths to another program. */
export const FIND_EXEC_FLAGS: ReadonlySet<string> = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
]);

/** Programs that mutate the filesystem when `find -exec` hands them a path. */
const MUTATING_EXEC: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "truncate",
  "mv",
  "cp",
  "ln",
  "install",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "chgrp",
  "tee",
  "dd",
  "sed",
  "perl",
  "gzip",
  "zip",
]);

export function writeTargets(segment: Segment): WriteTarget[] {
  const out: WriteTarget[] = [];

  // 1. Redirection. The tokeniser already separates `> file`, `>> file` and `&> file` from the
  //    word list, whatever program they are attached to — which is why this one rule covers
  //    `echo … > X`, `python3 … > X` and `some-unknown-binary > X` identically.
  for (const target of segment.redirects) out.push({ word: target, form: "redirection (> / >>)" });

  const name = program(segment);
  if (name === undefined) return out;
  const args = segment.argv.slice(1);
  const operands = args.filter((arg) => !arg.startsWith("-"));

  if (OPERANDS_ARE_WRITTEN.has(name)) {
    // `gzip -c` writes stdout and leaves the input alone; everything else rewrites in place.
    const toStdout =
      (name === "gzip" || name === "gunzip" || name === "bzip2" || name === "xz") &&
      (hasShortLetter(args, "c") || args.includes("--stdout") || args.includes("--to-stdout"));
    if (!toStdout) for (const operand of operands) out.push({ word: operand, form: name });
  }

  if (LAST_OPERAND_IS_WRITTEN.has(name)) {
    const destination = operands[operands.length - 1];
    if (destination !== undefined) out.push({ word: destination, form: `${name} (destination)` });
  }

  if (IN_PLACE_PROGRAMS.has(name) && hasInPlaceFlag(args)) {
    // Every operand, including the script argument. A script such as `s/a/b/` resolves under the
    // session directory and is classified `inside`, so over-collecting here cannot over-block —
    // and under-collecting would miss the file, which is the target that matters.
    for (const operand of operands) out.push({ word: operand, form: `${name} -i (in-place edit)` });
  }

  if (name === "find") out.push(...findTargets(args));

  if (name === "curl") {
    for (const value of shortValues(args, "o")) out.push({ word: value, form: "curl -o" });
    for (const value of longValues(args, ["output", "output-dir"])) {
      out.push({ word: value, form: "curl --output" });
    }
  }

  if (name === "wget") {
    for (const value of shortValues(args, "OP")) out.push({ word: value, form: "wget -O / -P" });
    for (const value of longValues(args, ["output-document", "directory-prefix"])) {
      out.push({ word: value, form: "wget --output-document" });
    }
  }

  if (name === "tar") {
    const normalized = normalizeTarLegacy(args);
    for (const value of shortValues(normalized, "C")) out.push({ word: value, form: "tar -C" });
    for (const value of longValues(normalized, ["directory"])) {
      out.push({ word: value, form: "tar --directory" });
    }
    if (tarCreates(normalized)) {
      for (const value of shortValues(normalized, "f")) out.push({ word: value, form: "tar -cf" });
      for (const value of longValues(normalized, ["file"])) {
        out.push({ word: value, form: "tar --file" });
      }
    }
  }

  if (name === "unzip") {
    for (const value of shortValues(args, "d")) out.push({ word: value, form: "unzip -d" });
  }

  if (name === "zip") {
    const archive = operands[0];
    if (archive !== undefined) out.push({ word: archive, form: "zip (archive)" });
  }

  if (name === "dd") {
    for (const arg of args) {
      if (arg.startsWith("of=")) out.push({ word: arg.slice(3), form: "dd of=" });
    }
  }

  return out;
}

/**
 * `find` is read-only until it is given an action. When it has one, the paths it can reach are its
 * ROOTS, so those are what gets located — `find / -delete` is refused for the same reason
 * `rm -rf /` is, and `find . -delete` is ordinary work for the same reason `rm -rf ./build` is.
 */
function findTargets(args: readonly string[]): WriteTarget[] {
  const out: WriteTarget[] = [];
  let form: string | undefined;

  if (args.includes("-delete")) form = "find -delete";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (FIND_FILE_ACTIONS.has(arg)) {
      // `-fprintf FILE FORMAT` puts the file first; `-fprint FILE` has only the file.
      const value = args[i + 1];
      if (value !== undefined) out.push({ word: value, form: `find ${arg}` });
    }
    if (FIND_EXEC_FLAGS.has(arg)) {
      const delegate = basename(args[i + 1] ?? "");
      if (MUTATING_EXEC.has(delegate)) form ??= `find ${arg} ${delegate}`;
    }
  }
  if (form === undefined) return out;

  const roots = rootsBeforeFirstPredicate(args);
  for (const root of roots.length > 0 ? roots : ["."]) out.push({ word: root, form });
  return out;
}

/** `find /a /b -name x` → `["/a", "/b"]`. `find -delete` → `[]`, which the caller reads as `.`. */
function rootsBeforeFirstPredicate(args: readonly string[]): string[] {
  const roots: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) break;
    roots.push(arg);
  }
  return roots;
}

// ---------------------------------------------------------------------------------------------
// Flag reading
// ---------------------------------------------------------------------------------------------

/** True when a single-dash cluster carries `letter`. `-pi` carries both `p` and `i`. */
function hasShortLetter(args: readonly string[], letter: string): boolean {
  for (const arg of args) {
    if (!arg.startsWith("-") || arg.startsWith("--") || arg === "-") continue;
    if (arg.slice(1).includes(letter)) return true;
  }
  return false;
}

/** `-i`, `-i.bak`, `-pi`, `-Ei`, `--in-place`, `--in-place=.bak`, `--inplace`. */
function hasInPlaceFlag(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--in-place" || arg === "--inplace") return true;
    if (arg.startsWith("--in-place=") || arg.startsWith("--inplace=")) return true;
    if (!arg.startsWith("-") || arg.startsWith("--") || arg === "-") continue;
    if (arg.slice(1).includes("i")) return true;
  }
  return false;
}

/**
 * Values of value-taking SHORT flags, attached or separate: `-o out`, `-oout`, `-qO-`.
 * Reading bundled clusters is the point — `wget -qO-` writes to stdout and `wget -qOx` does not.
 */
function shortValues(args: readonly string[], letters: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("-") || arg.startsWith("--") || arg === "-") continue;
    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j += 1) {
      if (!letters.includes(cluster[j]!)) continue;
      const attached = cluster.slice(j + 1);
      if (attached.length > 0) out.push(attached);
      else if (args[i + 1] !== undefined) out.push(args[i + 1]!);
      break;
    }
  }
  return out;
}

/** Values of `--name value` and `--name=value`. */
function longValues(args: readonly string[], names: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    if (!names.includes(key)) continue;
    if (eq !== -1) out.push(body.slice(eq + 1));
    else if (args[i + 1] !== undefined) out.push(args[i + 1]!);
  }
  return out;
}

/** `tar cf out.tar dir` — the historic dashless mode word. Rewritten as `-cf` for flag reading. */
function normalizeTarLegacy(args: readonly string[]): string[] {
  const first = args[0];
  if (first === undefined || first.startsWith("-") || !/^[A-Za-z]+$/.test(first)) return [...args];
  return [`-${first}`, ...args.slice(1)];
}

function tarCreates(args: readonly string[]): boolean {
  if (["--create", "--update", "--append", "--delete"].some((flag) => args.includes(flag))) {
    return true;
  }
  return hasShortLetter(args, "c") || hasShortLetter(args, "u") || hasShortLetter(args, "r");
}

function basename(word: string): string {
  const idx = word.lastIndexOf("/");
  return idx === -1 ? word : word.slice(idx + 1);
}
