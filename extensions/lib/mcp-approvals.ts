/**
 * Per-project approval records for MCP project config (`.mcp.json` / `.pi/mcp.json`).
 *
 * ## Why this exists
 *
 * `config/trusted-roots.json` answers a question about *code*: "may PI run in this directory
 * without asking?". Until this module, `extensions/trust.ts` handed the identical predicate to the
 * vendored MCP adapter, so path containment also decided "may this directory name the MCP servers
 * this agent spawns?". Those are not the same question, and conflating them is exploitable by the
 * single most ordinary action the operator performs:
 *
 *   git clone <hostile> ~/code/anything && cd ~/code/anything && pi
 *
 * `~/code` is a trusted root, so the clone inherited MCP-config trust the instant it landed
 * on disk. A `.pi/mcp.json` with `"lifecycle": "eager"` is then spawned during MCP initialization
 * (`pi-packages/pi-mcp-adapter/init.ts` startupServers), and the adapter's `resolveEnv` copies the
 * whole of `process.env` into that child — every credential this harness resolves. No `tool_call`
 * ever happens, so `extensions/guard.ts` never sees it.
 *
 * ## The rule
 *
 * MCP project config is admitted only when an **explicit, persisted approval record** names both
 * the project directory and the sha256 digest of that project's MCP config files. Unknown project
 * => DENY. Approved project whose files changed => DENY. There is no first-sight auto-approval and
 * no interactive prompt: eager servers spawn during initialization, long before a prompt could be
 * answered, so "ask" would be answered by the attacker's process starting.
 *
 * A project that carries no MCP config file at all is admitted — there is nothing for it to say,
 * enumerating the (absent) sources reads nothing, and refusing every ordinary repo would train the
 * operator to ignore the refusal that matters.
 *
 * ## Storage
 *
 * `~/.config/pi-config/mcp-approvals.jsonl` (`$XDG_CONFIG_HOME` honoured, `PI_MCP_APPROVALS`
 * overrides outright). Outside the repo, so a hostile repo cannot ship its own approval; `0600`
 * inside a `0700` directory, same posture as `~/.config/pi-config/copilot-pat`.
 *
 * JSON Lines, one record per line, append-only: `grep <project-path> ~/.config/pi-config/
 * mcp-approvals.jsonl` is the whole audit tool, and re-approval after an edit is one more line
 * rather than a rewrite. The LAST matching line for a directory wins.
 */
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The project files the adapter reads, in the order they enter the digest.
 *
 * These mirror `PROJECT_CONFIG_NAME` / `PROJECT_PI_CONFIG_NAME` in
 * `pi-packages/pi-mcp-adapter/config.ts`, which are module-private there. They are duplicated here
 * rather than imported so that `config/bin/pi-mcp-approve` stays a dependency-free script;
 * `test/mcp/project-approvals.test.ts` asserts the two lists still agree via the adapter's exported
 * `getProjectConfigPath` / `getProjectPiConfigPath`.
 */
export const PROJECT_MCP_FILES: readonly string[] = [".mcp.json", ".pi/mcp.json"];

export const APPROVALS_FILE_MODE = 0o600;
export const APPROVALS_DIR_MODE = 0o700;

/** Where the approval ledger lives. `PI_MCP_APPROVALS` wins, then `$XDG_CONFIG_HOME`, then `~`. */
export function approvalsPath(): string {
  const override = process.env.PI_MCP_APPROVALS;
  if (override !== undefined && override !== "") return resolve(override);
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "pi-config", "mcp-approvals.jsonl");
}

/** `realpath` where possible: a symlinked checkout must not be a second, unapproved identity. */
export function normaliseProjectDir(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export interface ProjectMcpFileDigest {
  /** Relative label, e.g. `.pi/mcp.json` — stable across machines, unlike the absolute path. */
  readonly file: string;
  /** `sha256:<hex>`, `absent`, or `unreadable:<code>`. All three are digest inputs. */
  readonly state: string;
}

export interface ProjectMcpDigest {
  readonly cwd: string;
  /** `sha256:<hex>` over every entry of `files`, in `PROJECT_MCP_FILES` order. */
  readonly digest: string;
  readonly files: readonly ProjectMcpFileDigest[];
  /** True when no project MCP file exists — nothing for the project to contribute. */
  readonly empty: boolean;
}

function fileState(path: string): string {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    return `unreadable:${code ?? "unknown"}`;
  }
  if (!stat.isFile()) return `unreadable:${stat.isDirectory() ? "EISDIR" : "ENOTFILE"}`;
  try {
    return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch (error) {
    return `unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

/**
 * Content identity of everything a project may use to define MCP servers.
 *
 * An unreadable file is NOT treated as absent: it is a distinct digest input, so a config that
 * cannot be hashed can never accidentally match an approval taken over a readable one.
 */
export function projectMcpDigest(cwd: string): ProjectMcpDigest {
  const dir = normaliseProjectDir(cwd);
  const files = PROJECT_MCP_FILES.map((file) => ({ file, state: fileState(join(dir, file)) }));
  const material = files.map((entry) => `${entry.file} ${entry.state}`).join("\n");
  return {
    cwd: dir,
    digest: `sha256:${createHash("sha256").update(material, "utf8").digest("hex")}`,
    files,
    empty: files.every((entry) => entry.state === "absent"),
  };
}

export interface McpApprovalRecord {
  readonly cwd: string;
  readonly digest: string;
  readonly approvedAt: string;
}

export interface ApprovalLedger {
  readonly path: string;
  readonly records: readonly McpApprovalRecord[];
  /** Malformed lines and read failures. Never swallowed — `trust.ts` prints them. */
  readonly problems: readonly string[];
}

function parseRecord(line: string, lineNumber: number, path: string): McpApprovalRecord | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return `${path}:${lineNumber} is not valid JSON — ignored`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `${path}:${lineNumber} is not a JSON object — ignored`;
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.cwd !== "string" || raw.cwd === "") return `${path}:${lineNumber} has no "cwd" — ignored`;
  if (typeof raw.digest !== "string" || !raw.digest.startsWith("sha256:")) {
    return `${path}:${lineNumber} has no "sha256:" digest — ignored`;
  }
  return {
    cwd: raw.cwd,
    digest: raw.digest,
    approvedAt: typeof raw.approvedAt === "string" ? raw.approvedAt : "unknown",
  };
}

/** Reads the ledger. A missing file is an empty ledger, not a problem — nothing is approved yet. */
export function readApprovals(path = approvalsPath()): ApprovalLedger {
  if (!existsSync(path)) return { path, records: [], problems: [] };
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (error) {
    return {
      path,
      records: [],
      problems: [
        `${path} could not be read (${(error as NodeJS.ErrnoException).code ?? "unknown"}) — ` +
          "no project MCP config is approved",
      ],
    };
  }
  const records: McpApprovalRecord[] = [];
  const problems: string[] = [];
  for (const [index, rawLine] of body.split("\n").entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parsed = parseRecord(line, index + 1, path);
    if (typeof parsed === "string") problems.push(parsed);
    else records.push(parsed);
  }
  return { path, records, problems };
}

export type McpApprovalOutcome = "no-project-config" | "approved" | "unknown-project" | "changed-config";

export interface McpApprovalDecision {
  readonly allowed: boolean;
  readonly outcome: McpApprovalOutcome;
  readonly cwd: string;
  readonly digest: ProjectMcpDigest;
  /** The digest the operator approved, when one exists and no longer matches. */
  readonly approvedDigest?: string;
  readonly approvedAt?: string;
}

/**
 * The rule, as a pure function of the project's content digest and the ledger. The LAST record for
 * a directory wins, so re-approval is an append.
 */
export function decideProjectMcpConfig(
  digest: ProjectMcpDigest,
  records: readonly McpApprovalRecord[],
): McpApprovalDecision {
  if (digest.empty) {
    return { allowed: true, outcome: "no-project-config", cwd: digest.cwd, digest };
  }
  let match: McpApprovalRecord | undefined;
  for (const record of records) {
    if (normaliseProjectDir(record.cwd) === digest.cwd) match = record;
  }
  if (match === undefined) {
    return { allowed: false, outcome: "unknown-project", cwd: digest.cwd, digest };
  }
  if (match.digest !== digest.digest) {
    return {
      allowed: false,
      outcome: "changed-config",
      cwd: digest.cwd,
      digest,
      approvedDigest: match.digest,
      approvedAt: match.approvedAt,
    };
  }
  return { allowed: true, outcome: "approved", cwd: digest.cwd, digest, approvedAt: match.approvedAt };
}

/** Convenience wrapper: hash the project, read the ledger, decide. */
export function evaluateProjectMcpConfig(
  cwd: string,
  path = approvalsPath(),
): { decision: McpApprovalDecision; ledger: ApprovalLedger } {
  const ledger = readApprovals(path);
  return { decision: decideProjectMcpConfig(projectMcpDigest(cwd), ledger.records), ledger };
}

/** The command that turns a refusal into an approval. Named once, quoted everywhere. */
export function approveCommand(repoRootPath: string, cwd: string): string {
  return `${join(repoRootPath, "config", "bin", "pi-mcp-approve")} ${cwd}`;
}

/**
 * The operator-facing refusal. Loud by construction: it names the project, the refused digest, the
 * per-file hashes (so a diff is possible), what was NOT done, and the exact approval command.
 */
export function describeRefusal(decision: McpApprovalDecision, repoRootPath: string): string {
  const why =
    decision.outcome === "changed-config"
      ? `its MCP config CHANGED since approval (approved ${decision.approvedDigest} on ${decision.approvedAt ?? "unknown"})`
      : "it has never been approved";
  const perFile = decision.digest.files.map((entry) => `${entry.file}=${entry.state}`).join(", ");
  return (
    `trust: REFUSED the MCP project config of ${decision.cwd} — ${why}. ` +
    `Refused digest ${decision.digest.digest} (${perFile}). ` +
    ".mcp.json and .pi/mcp.json were NOT read and no project-defined MCP server was started. " +
    `Review those files, then approve with:  ${approveCommand(repoRootPath, decision.cwd)}  ` +
    "and restart the session."
  );
}

/**
 * Appends an approval. The parent is created at `0700`; the ledger is created at `0600` and the
 * mode is re-asserted on every write, so a loosened file mode is corrected rather than inherited.
 *
 * The *directory* mode is checked, not forced: `mkdirSync`'s mode applies only to directories this
 * call creates, and chmod'ing a pre-existing directory the operator already owns (`$XDG_CONFIG_HOME`
 * may be shared) is not this tool's business. A group- or world-accessible parent is reported
 * through `warn` instead — anyone who can write that directory can replace the ledger.
 */
export function recordApproval(
  cwd: string,
  digest: string,
  path = approvalsPath(),
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): McpApprovalRecord {
  const record: McpApprovalRecord = {
    cwd: normaliseProjectDir(cwd),
    digest,
    approvedAt: new Date().toISOString(),
  };
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: APPROVALS_DIR_MODE });
  const dirMode = statSync(dir).mode & 0o777;
  if ((dirMode & 0o077) !== 0) {
    warn(
      `[pi-config] mcp-approvals: ${dir} is mode ${dirMode.toString(8)}, not 700 — anyone with ` +
        "write access there can forge an MCP approval",
    );
  }
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: APPROVALS_FILE_MODE });
  chmodSync(path, APPROVALS_FILE_MODE);
  return record;
}
