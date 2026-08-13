/**
 * I/O layer: everything `/doctor` reads off disk to build the *declared* roster — as opposed to
 * whatever happens to be live in `pi.getAllTools()` / `pi.getCommands()` this session.
 *
 * Kept separate from `checks.ts` (pure functions over plain data) so the checks can be unit
 * tested without a filesystem, and separate from `doctor.ts` (owns the live `ExtensionAPI` /
 * `ExtensionContext` calls) so this module can be unit tested without a live `pi` process. Every
 * function here takes an explicit `root` rather than calling `../lib/paths.ts`'s `repoRoot()`
 * itself, for the same reason `skill-mask.ts` keeps its own root resolution thin and testable —
 * `doctor.ts` is the one call site that supplies the real root.
 *
 * Absence is data, not an error: a colleague's trimmed-down clone with no `skills-work/`, no
 * `agents/` yet (EXT-05's content port), or no `config/mcp.json` (MCP never opted into) is a
 * legitimate declared-empty state, and every reader below returns an empty/default result for
 * ENOENT rather than throwing. A file that *exists* but does not parse as JSON is different — that
 * is corruption, not absence, and is thrown as a named error so it surfaces at `/doctor` load
 * rather than silently becoming "nothing declared".
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DeclaredTool {
  readonly name: string;
  readonly source: string;
  readonly note?: string;
}

export interface DeclaredAgents {
  /** Whether `<root>/agents/` exists at all — `D-03`'s wave-1-vs-wave-2 severity switch. */
  readonly rootExists: boolean;
  readonly ids: readonly string[];
}

export interface RoutingTierDeclaration {
  readonly tier: string;
  /** `"provider/id"`, split on the FIRST `/` only — model ids can contain `/` themselves
   *  (e.g. `local/vendor/Model-30B-A3B-GGUF`). */
  readonly modelRef: string;
  readonly fallbackRef?: string;
  readonly optional: boolean;
}

export interface PackageLockDeclaration {
  readonly name: string;
  readonly version: string;
  readonly vendor: boolean;
  readonly status: string;
}

/** Reads a JSON file, tolerating absence (`onMissing`) but not corruption (throws, named). */
function readJson(path: string, onMissing: () => unknown): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return onMissing();
    throw new Error(`doctor: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `doctor: ${path} exists but is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** `config/tools.declared.json` — `D-01`'s roster of tool names PI's live registry may not have
 *  yet (uncredentialed provider, package not loaded this session, …). */
export function readDeclaredTools(root: string): readonly DeclaredTool[] {
  const doc = readJson(join(root, "config", "tools.declared.json"), () => ({ tools: [] })) as {
    tools?: unknown;
  };
  if (!Array.isArray(doc.tools)) return [];
  return doc.tools
    .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
    .filter((t) => typeof t.name === "string")
    .map((t) => ({
      name: t.name as string,
      source: typeof t.source === "string" ? t.source : "unknown",
      ...(typeof t.note === "string" ? { note: t.note } : {}),
    }));
}

/** The three skill roots' immediate children that carry a `SKILL.md` — `D-02`'s declared roster,
 *  deliberately independent of which roots this *session* actually widened into (skill-mask.ts).
 *  `skill-bundles/` is excluded: its nested packages are not addressed by name in the ported
 *  instruction text, only through their parent skill. */
const SKILL_ROOTS = ["skills", "skills-work", "skills-private"] as const;

export function discoverDeclaredSkills(root: string): readonly string[] {
  const ids: string[] = [];
  for (const skillRoot of SKILL_ROOTS) {
    const dir = join(root, skillRoot);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // root not present in this clone — not an error, see module docstring
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(entryPath).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      try {
        statSync(join(entryPath, "SKILL.md"));
        ids.push(entry);
      } catch {
        // a directory without SKILL.md at its root is not a skill (e.g. a stray asset folder)
      }
    }
  }
  return ids;
}

/** `<root>/agents/*.md` — `D-03`. Existence-only until `EXT-05`'s content port lands frontmatter
 *  validation (`PC-03` owns the frontmatter shape check; this is only "does the file exist"). */
export function discoverDeclaredAgents(root: string): DeclaredAgents {
  const dir = join(root, "agents");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { rootExists: false, ids: [] };
  }
  const ids = entries.filter((e) => e.endsWith(".md")).map((e) => e.slice(0, -".md".length));
  return { rootExists: true, ids };
}

/** `config/mcp.json`'s `mcpServers` keys — `D-07`. Regardless of `disabled`: a server a colleague
 *  has switched off is still a *declared* one, and referencing it by name is not drift. */
export function readDeclaredServers(root: string): readonly string[] {
  const doc = readJson(join(root, "config", "mcp.json"), () => ({ mcpServers: {} })) as {
    mcpServers?: unknown;
  };
  if (typeof doc.mcpServers !== "object" || doc.mcpServers === null) return [];
  return Object.keys(doc.mcpServers as Record<string, unknown>);
}

/** `config/routing.json`'s tiers — `D-04`. `fallback` is read defensively (optional field) even
 *  though the current file has none: `REQ-PRV-89`'s failover chain was cancelled (EXT-08), so a
 *  `fallback` key surviving in a tier is itself worth a finding if `checks.ts` ever adds one, but
 *  today's file has none to read. */
export function readRoutingTiers(root: string): readonly RoutingTierDeclaration[] {
  const doc = readJson(join(root, "config", "routing.json"), () => ({ tiers: {} })) as {
    tiers?: unknown;
  };
  if (typeof doc.tiers !== "object" || doc.tiers === null) return [];
  const out: RoutingTierDeclaration[] = [];
  for (const [tier, raw] of Object.entries(doc.tiers as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const t = raw as Record<string, unknown>;
    if (typeof t.model !== "string") continue;
    out.push({
      tier,
      modelRef: t.model,
      ...(typeof t.fallback === "string" ? { fallbackRef: t.fallback } : {}),
      optional: t.optional === true,
    });
  }
  return out;
}

/** `config/packages.lock.json`'s `packages` array — `D-08`. */
export function readPackagesLock(root: string): readonly PackageLockDeclaration[] {
  const doc = readJson(join(root, "config", "packages.lock.json"), () => ({ packages: [] })) as {
    packages?: unknown;
  };
  if (!Array.isArray(doc.packages)) return [];
  return doc.packages
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .filter((p) => typeof p.name === "string" && typeof p.version === "string")
    .map((p) => ({
      name: p.name as string,
      version: p.version as string,
      vendor: p.vendor === true,
      status: typeof p.status === "string" ? p.status : "unknown",
    }));
}

/** The installed version of `name` under `<root>/node_modules`, or `undefined` when the package
 *  is not installed at all — `D-08`'s "expected-but-absent" half (R-13). Scoped names
 *  (`@scope/name`) resolve the same way `node_modules` itself lays them out: one extra path
 *  segment, no special-casing needed beyond what `join` already does. */
export function resolveInstalledPackageVersion(root: string, name: string): string | undefined {
  const pkgJsonPath = join(root, "node_modules", ...name.split("/"), "package.json");
  const parsed = readJson(pkgJsonPath, () => undefined) as { version?: unknown } | undefined;
  if (parsed === undefined) return undefined;
  return typeof parsed.version === "string" ? parsed.version : undefined;
}
