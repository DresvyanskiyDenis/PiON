// F1 layer 1 — `extensions/lib/mcp-approvals.ts`, the persisted per-project consent that replaced
// "this path is under a trusted root" as the answer to "may this repo name our MCP servers?".
//
// The pure half (digest + decision) is asserted without touching the real ledger; the I/O half runs
// entirely inside scratch dirs under $TMPDIR and cleans up after itself.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  APPROVALS_DIR_MODE,
  APPROVALS_FILE_MODE,
  PROJECT_MCP_FILES,
  approvalsPath,
  decideProjectMcpConfig,
  describeRefusal,
  evaluateProjectMcpConfig,
  normaliseProjectDir,
  projectMcpDigest,
  readApprovals,
  recordApproval,
} from "../../extensions/lib/mcp-approvals.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ADAPTER_CONFIG = join(REPO_ROOT, "pi-packages", "pi-mcp-adapter", "config.ts");

const scratchDirs: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (scratchDirs.length > 0) {
    await rm(scratchDirs.pop()!, { recursive: true, force: true });
  }
});

describe("PROJECT_MCP_FILES", () => {
  let getProjectConfigPath: (cwd?: string) => string;
  let getProjectPiConfigPath: (cwd?: string) => string;

  before(async () => {
    ({ getProjectConfigPath, getProjectPiConfigPath } = await import(ADAPTER_CONFIG));
  });

  it("still names exactly the files the vendored adapter reads", () => {
    // The two names are module-private in the adapter, so this list is a copy. A copy that drifts is
    // a hole: a file the adapter reads but the digest does not cover could change after approval.
    const base = join(tmpdir(), "pi-approvals-name-check");
    const adapterPaths = [getProjectConfigPath(base), getProjectPiConfigPath(base)];
    assert.deepEqual(
      PROJECT_MCP_FILES.map((file) => join(base, file)),
      adapterPaths,
    );
  });
});

describe("projectMcpDigest", () => {
  it("reports `empty` when neither file exists, and a stable digest for that state", async () => {
    const dir = await scratch("pi-approvals-empty-");
    const first = projectMcpDigest(dir);
    assert.equal(first.empty, true);
    assert.deepEqual(
      first.files.map((f) => f.state),
      ["absent", "absent"],
    );
    assert.equal(projectMcpDigest(dir).digest, first.digest, "the digest must be a pure function");
  });

  it("changes when either file changes, and distinguishes which one carries the bytes", async () => {
    // `.mcp.json = X, .pi/mcp.json = absent` must not hash the same as the swap — otherwise moving
    // an approved config between the two names would silently keep the approval.
    const a = await scratch("pi-approvals-a-");
    const b = await scratch("pi-approvals-b-");
    await writeFile(join(a, ".mcp.json"), "{}", "utf8");
    await mkdir(join(b, ".pi"), { recursive: true });
    await writeFile(join(b, ".pi", "mcp.json"), "{}", "utf8");
    assert.notEqual(projectMcpDigest(a).digest, projectMcpDigest(b).digest);
    assert.equal(projectMcpDigest(a).empty, false);
  });

  it("treats an unreadable file as its own state, never as absent", async () => {
    // A directory called `.mcp.json` cannot be read, and must not hash like "there is no config".
    const dir = await scratch("pi-approvals-unreadable-");
    await mkdir(join(dir, ".mcp.json"), { recursive: true });
    const digest = projectMcpDigest(dir);
    assert.equal(digest.empty, false, "unreadable is not absent");
    assert.match(digest.files[0]!.state, /^unreadable:/);
  });

  it("realpaths the directory, so a symlinked checkout is not a second identity", async () => {
    const dir = await scratch("pi-approvals-real-");
    assert.equal(projectMcpDigest(dir).cwd, normaliseProjectDir(dir));
  });
});

describe("decideProjectMcpConfig", () => {
  const digest = {
    cwd: "/p",
    digest: "sha256:aaa",
    files: [{ file: ".mcp.json", state: "sha256:aaa" }],
    empty: false,
  } as const;

  it("allows a project with no config at all", () => {
    const decision = decideProjectMcpConfig({ ...digest, empty: true }, []);
    assert.equal(decision.allowed, true);
    assert.equal(decision.outcome, "no-project-config");
  });

  it("denies an unknown project — first sight is never consent", () => {
    const decision = decideProjectMcpConfig(digest, []);
    assert.equal(decision.allowed, false);
    assert.equal(decision.outcome, "unknown-project");
  });

  it("denies a changed config and keeps the digest that WAS approved, for the diff", () => {
    const decision = decideProjectMcpConfig(digest, [
      { cwd: "/p", digest: "sha256:old", approvedAt: "2026-08-01T00:00:00.000Z" },
    ]);
    assert.equal(decision.allowed, false);
    assert.equal(decision.outcome, "changed-config");
    assert.equal(decision.approvedDigest, "sha256:old");
  });

  it("lets the LAST record win, so re-approval is an append and revocation is possible", () => {
    const records = [
      { cwd: "/p", digest: "sha256:aaa", approvedAt: "1" },
      { cwd: "/p", digest: "sha256:bbb", approvedAt: "2" },
    ];
    assert.equal(decideProjectMcpConfig(digest, records).outcome, "changed-config");
    assert.equal(decideProjectMcpConfig(digest, [...records].reverse()).outcome, "approved");
  });

  it("does not let one project's approval cover another", () => {
    const decision = decideProjectMcpConfig(digest, [
      { cwd: "/other", digest: "sha256:aaa", approvedAt: "1" },
    ]);
    assert.equal(decision.allowed, false);
  });
});

describe("readApprovals", () => {
  it("treats a missing ledger as empty, not as a problem — nothing is approved yet", () => {
    const ledger = readApprovals(join(tmpdir(), "pi-approvals-does-not-exist", "x.jsonl"));
    assert.deepEqual(ledger.records, []);
    assert.deepEqual(ledger.problems, []);
  });

  it("skips blank and # lines, keeps good records, and REPORTS every bad one", async () => {
    const dir = await scratch("pi-approvals-parse-");
    const path = join(dir, "mcp-approvals.jsonl");
    await writeFile(
      path,
      [
        "# a comment",
        "",
        JSON.stringify({ cwd: "/p", digest: "sha256:aaa", approvedAt: "1" }),
        "{not json",
        JSON.stringify({ cwd: "/p" }),
        JSON.stringify({ cwd: "/p", digest: "md5:nope" }),
        JSON.stringify(["array"]),
      ].join("\n"),
      "utf8",
    );
    const ledger = readApprovals(path);
    assert.equal(ledger.records.length, 1);
    assert.equal(ledger.problems.length, 4, "a silently dropped record is a silently lost approval");
    for (const problem of ledger.problems) assert.match(problem, /ignored$/);
  });
});

describe("recordApproval", () => {
  it("creates a 0700 directory and a 0600 ledger, and appends rather than rewrites", async () => {
    const dir = await scratch("pi-approvals-write-");
    const path = join(dir, "nested", "mcp-approvals.jsonl");
    const project = await scratch("pi-approvals-project-");
    await writeFile(join(project, ".mcp.json"), "{}", "utf8");

    const first = recordApproval(project, projectMcpDigest(project).digest, path, () => {});
    assert.equal(statSync(dirname(path)).mode & 0o777, APPROVALS_DIR_MODE);
    assert.equal(statSync(path).mode & 0o777, APPROVALS_FILE_MODE);
    assert.equal(first.cwd, normaliseProjectDir(project), "the record stores the realpath");

    recordApproval(project, "sha256:second", path, () => {});
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2, "append-only: the audit trail survives re-approval");
    assert.equal(readApprovals(path).records.length, 2);
  });

  it("warns instead of throwing when the parent directory is group- or world-accessible", async () => {
    // $TMPDIR-shaped parents are the normal case for this warning; chmod'ing a directory the
    // operator owns is not this tool's business, but staying quiet about it would be.
    const dir = await scratch("pi-approvals-loose-");
    const warnings: string[] = [];
    recordApproval("/p", "sha256:aaa", join(dir, "mcp-approvals.jsonl"), (line) =>
      warnings.push(line),
    );
    // The scratch dir itself is 0700, so this asserts the quiet path; the loud path is asserted by
    // pointing at $TMPDIR, which is 0777 with the sticky bit on macOS and 1777 on Linux.
    assert.deepEqual(warnings, []);
    const loose: string[] = [];
    recordApproval("/p", "sha256:aaa", join(tmpdir(), "pi-approvals-loose-parent.jsonl"), (line) =>
      loose.push(line),
    );
    if ((statSync(tmpdir()).mode & 0o077) !== 0) {
      assert.equal(loose.length, 1);
      assert.match(loose[0]!, /can forge an MCP approval/);
    }
    await rm(join(tmpdir(), "pi-approvals-loose-parent.jsonl"), { force: true });
  });
});

describe("evaluateProjectMcpConfig / describeRefusal", () => {
  it("round-trips: refused, then approved, then refused again after an edit", async () => {
    const dir = await scratch("pi-approvals-round-");
    const ledgerPath = join(await scratch("pi-approvals-ledger-"), "mcp-approvals.jsonl");
    await mkdir(join(dir, ".pi"), { recursive: true });
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");

    assert.equal(evaluateProjectMcpConfig(dir, ledgerPath).decision.outcome, "unknown-project");
    recordApproval(dir, projectMcpDigest(dir).digest, ledgerPath, () => {});
    assert.equal(evaluateProjectMcpConfig(dir, ledgerPath).decision.allowed, true);
    await writeFile(join(dir, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { x: {} } }), "utf8");
    assert.equal(evaluateProjectMcpConfig(dir, ledgerPath).decision.outcome, "changed-config");
  });

  it("refuses loudly: the project, the reason, the digest, what did NOT happen, and the remedy", async () => {
    const dir = await scratch("pi-approvals-loud-");
    const ledgerPath = join(await scratch("pi-approvals-ledger2-"), "mcp-approvals.jsonl");
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");
    const { decision } = evaluateProjectMcpConfig(dir, ledgerPath);
    const message = describeRefusal(decision, "/repo");

    assert.match(message, new RegExp(normaliseProjectDir(dir)), "names the project");
    assert.match(message, /never been approved/, "names the reason");
    assert.match(message, /sha256:[0-9a-f]{64}/, "names the refused digest");
    assert.match(message, /were NOT read and no project-defined MCP server was started/);
    assert.match(message, new RegExp(join("/repo", "config", "bin", "pi-mcp-approve")));
    assert.match(message, /restart the session/);
  });

  it("names the previously approved digest when the config changed under an approval", async () => {
    const decision = decideProjectMcpConfig(
      { cwd: "/p", digest: "sha256:new", files: [], empty: false },
      [{ cwd: "/p", digest: "sha256:old", approvedAt: "2026-08-01T00:00:00.000Z" }],
    );
    const message = describeRefusal(decision, "/repo");
    assert.match(message, /CHANGED since approval \(approved sha256:old on 2026-08-01/);
  });
});

describe("approvalsPath", () => {
  const original = { override: process.env.PI_MCP_APPROVALS, xdg: process.env.XDG_CONFIG_HOME };

  afterEach(() => {
    if (original.override === undefined) delete process.env.PI_MCP_APPROVALS;
    else process.env.PI_MCP_APPROVALS = original.override;
    if (original.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = original.xdg;
  });

  it("lives OUTSIDE the repo, so a hostile repo cannot ship its own approval", () => {
    delete process.env.PI_MCP_APPROVALS;
    delete process.env.XDG_CONFIG_HOME;
    const path = approvalsPath();
    assert.match(path, /\.config[/\\]pi-config[/\\]mcp-approvals\.jsonl$/);
    assert.ok(!path.startsWith(REPO_ROOT), "the ledger must never be inside a checkout");
  });

  it("honours XDG_CONFIG_HOME, then PI_MCP_APPROVALS as an outright override", () => {
    delete process.env.PI_MCP_APPROVALS;
    process.env.XDG_CONFIG_HOME = join(tmpdir(), "xdg");
    assert.equal(approvalsPath(), join(tmpdir(), "xdg", "pi-config", "mcp-approvals.jsonl"));
    process.env.PI_MCP_APPROVALS = join(tmpdir(), "explicit.jsonl");
    assert.equal(approvalsPath(), join(tmpdir(), "explicit.jsonl"));
  });
});
