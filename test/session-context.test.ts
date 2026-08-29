import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { DispatchSettings } from "../extensions/dispatch/config.ts";
import {
  __resetForTests,
  __state,
  MARK_CLOSE,
  MARK_OPEN,
  MAX_BLOCK_BYTES,
  capBytes,
  collect,
  injectOnce,
  isInsideRepo,
  makeAnnounce,
  operatorCandidates,
  readLiveModel,
  register,
  render,
  resolveOperator,
  resolveSubagentDefault,
  safeSessionId,
  stripBlock,
  todayKey,
} from "../extensions/session-context.ts";

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "PI_IDENTITY_PATH",
  "PI_OPERATOR_FILE",
  "PI_CONFIG_REPO",
  "PI_CODING_AGENT_DIR",
  "XDG_STATE_HOME",
  "PI_SCRATCH_DIR",
] as const;

let sandbox: string;
let savedEnv: Record<string, string | undefined>;

before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-ctx-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  __resetForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Swallows and returns everything the module announces on stderr. */
async function captureStderr<T>(fn: () => Promise<T> | T): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  };
  try {
    return { value: await fn(), lines };
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
}

interface ExecReply {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/** A fake `pi` whose `exec` answers from a table keyed on the joined argv. */
function fakePi(execTable: Record<string, ExecReply> = {}) {
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
  const commands = new Map<string, { description?: string; handler: Function }>();
  const execCalls: string[][] = [];
  const pi = {
    on(event: string, handler: (e: unknown, c: unknown) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, options: { description?: string; handler: Function }) {
      commands.set(name, options);
    },
    async exec(_command: string, args: string[]) {
      execCalls.push(args);
      const reply = execTable[args.join(" ")] ?? { code: 128, stderr: "unstubbed" };
      return {
        stdout: reply.stdout ?? "",
        stderr: reply.stderr ?? "",
        code: reply.code ?? 0,
        killed: false,
      };
    },
  };
  return { pi: pi as unknown as ExtensionAPI, handlers, commands, execCalls };
}

interface FakeCtxOptions {
  cwd?: string;
  sessionId?: string;
  systemPrompt?: string;
}

function fakeCtx(options: FakeCtxOptions = {}) {
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = {
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
    mode: "print",
    hasUI: false,
    cwd: options.cwd ?? sandbox,
    sessionManager: { getSessionId: () => options.sessionId ?? "sess-abc" },
    getSystemPrompt: () => options.systemPrompt ?? "BASE PROMPT",
  };
  return { ctx: ctx as unknown as ExtensionContext & ExtensionCommandContext, notifications };
}

const GIT_OK: Record<string, ExecReply> = {
  "rev-parse --is-inside-work-tree": { stdout: "true\n" },
  "branch --show-current": { stdout: "feature/implement-waves\n" },
  "log -5 --oneline --no-decorate": { stdout: "abc1234 feat: one\ndef5678 fix: two\n" },
  "status --porcelain": { stdout: " M a.ts\n?? b.ts\n" },
};
const GIT_NOT_A_REPO: Record<string, ExecReply> = {
  "rev-parse --is-inside-work-tree": { code: 128, stderr: "fatal: not a git repository" },
};

const countMarkerLines = (s: string): number =>
  s.split("\n").filter((l) => l.includes("pi-config:session-context v1")).length;

// ---------------------------------------------------------------------------

describe("injectOnce / stripBlock — REQ-CTX-17", () => {
  it("injects exactly one block and stays at one after repeated application", () => {
    let prompt = "SYSTEM\nrules here";
    for (let i = 0; i < 10; i++) prompt = injectOnce(prompt, `## Today\n2026-08-07 #${i}`);
    assert.equal(countMarkerLines(prompt), 2, "one open marker line and one close marker line");
    assert.equal(prompt.split(MARK_OPEN).length - 1, 1);
    assert.equal(prompt.split(MARK_CLOSE).length - 1, 1);
    assert.match(prompt, /#9/, "the last block wins");
    assert.doesNotMatch(prompt, /#8/);
    assert.match(prompt, /^SYSTEM\nrules here/);
  });

  it("heals a prompt that already carries several stacked blocks", () => {
    const stacked = `A\n${MARK_OPEN}\nold1\n${MARK_CLOSE}\nB\n${MARK_OPEN}\nold2\n${MARK_CLOSE}\nC`;
    assert.equal(countMarkerLines(stacked), 4);
    assert.equal(countMarkerLines(injectOnce(stacked, "new")), 2);
    assert.equal(stripBlock(stacked).includes("old1"), false);
    assert.equal(stripBlock(stacked).includes("old2"), false);
    assert.match(stripBlock(stacked), /A/);
    assert.match(stripBlock(stacked), /C/);
  });

  it("tolerates an open marker with no close marker", () => {
    const truncated = `A\n${MARK_OPEN}\nhalf a block`;
    assert.equal(stripBlock(truncated), "A\n");
    assert.equal(countMarkerLines(injectOnce(truncated, "new")), 2);
  });

  it("caps the injected block at MAX_BLOCK_BYTES and announces the cut — REQ-CTX-33", () => {
    const huge = "x".repeat(200 * 1024);
    const out = injectOnce("SYSTEM", huge);
    const block = out.slice(out.indexOf(MARK_OPEN), out.indexOf(MARK_CLOSE) + MARK_CLOSE.length);
    const size = Buffer.byteLength(block, "utf8");
    // The cap covers the delimited block, markers and notice included.
    assert.ok(size <= MAX_BLOCK_BYTES, `block was ${size} bytes`);
    assert.ok(size > MAX_BLOCK_BYTES - 200, `block was ${size} bytes — the budget must be used`);
    assert.match(block, /session-context truncated to 8192 bytes/);
  });
});

describe("capBytes", () => {
  it("is byte-accurate, not character-accurate", () => {
    const cyrillic = "я".repeat(100); // 200 bytes, 100 chars
    assert.equal(Buffer.byteLength(cyrillic, "utf8"), 200);
    const out = capBytes(cyrillic, 50, "[cut]");
    assert.ok(out.startsWith("я".repeat(25)));
    assert.match(out, /\[cut\]$/);
  });

  it("never emits a dangling replacement character from a mid-sequence cut", () => {
    const out = capBytes("я".repeat(100), 51, "[cut]");
    assert.equal(out.includes("�"), false);
  });

  it("returns the input untouched when it fits", () => {
    assert.equal(capBytes("short", 100, "[cut]"), "short");
  });
});

describe("todayKey — REQ-CTX-11", () => {
  it("formats local time as YYYY-MM-DD, zero-padded", () => {
    assert.equal(todayKey(new Date(2026, 0, 3, 12, 0, 0)), "2026-01-03");
    assert.equal(todayKey(new Date(2026, 11, 31, 12, 0, 0)), "2026-12-31");
    assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("safeSessionId", () => {
  it("cannot escape the scratch root", () => {
    for (const hostile of ["../../etc/passwd", "..", "./..", "a/../../b", "\\..\\..", ".hidden"]) {
      const out = safeSessionId(hostile);
      assert.equal(out.includes("/"), false, hostile);
      assert.equal(out.includes("\\"), false, hostile);
      assert.equal(out.includes(".."), false, hostile);
      assert.equal(out.startsWith("."), false, hostile);
      assert.ok(out.length > 0, hostile);
    }
    assert.equal(safeSessionId("a/b"), "a_b");
    assert.equal(safeSessionId(""), "unknown-session");
  });

  it("leaves a realistic session id alone, so two ids cannot collide on one directory", () => {
    assert.equal(safeSessionId("01JQ-ok_id.v1"), "01JQ-ok_id.v1");
    assert.equal(safeSessionId("018f2c1e-7a3b-7c9d-8e5f-1a2b3c4d5e6f"), "018f2c1e-7a3b-7c9d-8e5f-1a2b3c4d5e6f");
    assert.notEqual(safeSessionId("a.b"), safeSessionId("a_b"));
  });
});

describe("operator resolution — REQ-CTX-13", () => {
  it("searches env override, then the out-of-repo overlay, then the tracked generic file", () => {
    process.env.PI_CONFIG_REPO = join(sandbox, "repo");
    process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
    process.env.PI_IDENTITY_PATH = join(sandbox, "id.md");
    process.env.PI_OPERATOR_FILE = join(sandbox, "op.md");
    const paths = operatorCandidates().map((c) => c.path);
    assert.deepEqual(paths, [
      join(sandbox, "id.md"),
      join(sandbox, "op.md"),
      join(sandbox, "agent", "OPERATOR.local.md"),
      join(sandbox, "repo", "config", "operator", "OPERATOR.md"),
    ]);
    assert.deepEqual(
      operatorCandidates().map((c) => c.allowInRepo),
      [false, false, false, true],
    );
  });

  it("skips an unset or blank env override", () => {
    delete process.env.PI_IDENTITY_PATH;
    process.env.PI_OPERATOR_FILE = "   ";
    process.env.PI_CONFIG_REPO = join(sandbox, "repo");
    process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
    assert.equal(operatorCandidates().length, 2);
  });

  it("isInsideRepo is not fooled by a prefix sibling", () => {
    process.env.PI_CONFIG_REPO = join(sandbox, "repo");
    assert.equal(isInsideRepo(join(sandbox, "repo", "a", "b.md")), true);
    assert.equal(isInsideRepo(join(sandbox, "repo-other", "b.md")), false);
    assert.equal(isInsideRepo(join(sandbox, "elsewhere.md")), false);
  });

  it("first readable hit wins and later candidates are not reached", async () => {
    const dir = await mkdtemp(join(sandbox, "op-order-"));
    process.env.PI_CONFIG_REPO = join(dir, "repo");
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    await mkdir(join(dir, "agent"), { recursive: true });
    await mkdir(join(dir, "repo", "config", "operator"), { recursive: true });
    await writeFile(join(dir, "agent", "OPERATOR.local.md"), "LOCAL OVERLAY\n", "utf8");
    await writeFile(join(dir, "repo", "config", "operator", "OPERATOR.md"), "GENERIC\n", "utf8");

    const res = await resolveOperator();
    assert.equal(res.hit?.text.trim(), "LOCAL OVERLAY");
    assert.equal(res.hit?.path, join(dir, "agent", "OPERATOR.local.md"));
    assert.match(res.searched.at(-1) ?? "", /not reached/);
    assert.deepEqual(res.refusals, []);
  });

  it("REFUSES an identity file that resolves inside the repo, and says why", async () => {
    const dir = await mkdtemp(join(sandbox, "op-refuse-"));
    process.env.PI_CONFIG_REPO = join(dir, "repo");
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    await mkdir(join(dir, "repo", "config", "operator"), { recursive: true });
    await writeFile(join(dir, "repo", "identity.md"), "PERSONAL IDENTITY CONTENT\n", "utf8");
    await writeFile(join(dir, "repo", "config", "operator", "OPERATOR.md"), "GENERIC\n", "utf8");
    process.env.PI_IDENTITY_PATH = join(dir, "repo", "identity.md");

    const res = await resolveOperator();
    assert.equal(res.refusals.length, 1);
    assert.match(res.refusals[0] ?? "", /REFUSED/);
    assert.match(res.refusals[0] ?? "", /must not live inside the repository/);
    assert.equal(res.hit?.text.trim(), "GENERIC", "falls through to the tracked generic file");
    const rendered = JSON.stringify(res);
    assert.equal(
      rendered.includes("PERSONAL IDENTITY CONTENT"),
      false,
      "the refused file must never be read",
    );
  });

  it("still refuses when the repo path IS the git-ignored overlay name", async () => {
    const dir = await mkdtemp(join(sandbox, "op-refuse2-"));
    process.env.PI_CONFIG_REPO = join(dir, "repo");
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    await mkdir(join(dir, "repo", "config", "operator"), { recursive: true });
    await writeFile(
      join(dir, "repo", "config", "operator", "OPERATOR.local.md"),
      "PERSONAL TEXT IN THE REPO\n",
      "utf8",
    );
    process.env.PI_OPERATOR_FILE = join(dir, "repo", "config", "operator", "OPERATOR.local.md");
    const res = await resolveOperator();
    assert.equal(res.hit, null);
    assert.equal(res.refusals.length, 1);
    assert.equal(JSON.stringify(res).includes("PERSONAL TEXT IN THE REPO"), false);
  });

  it("records a miss for every candidate when nothing resolves", async () => {
    const dir = await mkdtemp(join(sandbox, "op-miss-"));
    process.env.PI_CONFIG_REPO = join(dir, "repo");
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    process.env.PI_OPERATOR_FILE = join(dir, "nonexistent", "OPERATOR.md");
    delete process.env.PI_IDENTITY_PATH;

    const res = await resolveOperator();
    assert.equal(res.hit, null);
    assert.equal(res.searched.length, 3);
    for (const line of res.searched) assert.match(line, /not found/);
  });

  it("reports an unreadable candidate as a refusal, not as absence", async () => {
    const dir = await mkdtemp(join(sandbox, "op-eisdir-"));
    process.env.PI_CONFIG_REPO = join(dir, "repo");
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    await mkdir(join(dir, "a-directory"), { recursive: true });
    process.env.PI_OPERATOR_FILE = join(dir, "a-directory");
    delete process.env.PI_IDENTITY_PATH;

    const res = await resolveOperator();
    assert.equal(res.hit, null);
    assert.equal(res.refusals.length, 1);
    assert.match(res.refusals[0] ?? "", /unreadable/);
  });
});

describe("render", () => {
  const base = {
    sessionId: "s1",
    scratch: "/state/scratch/s1",
    dateKey: "2026-08-07",
    epoch: 1,
    live: {
      model: "github-copilot/claude-opus-5",
      thinkingLevel: "high",
      contextWindow: 200_000,
      problem: null,
    },
    subagent: {
      tier: "light",
      model: "github-copilot/claude-sonnet-5",
      thinkingLevel: "medium",
      problem: null,
    },
    projectState: "",
    architecture: "",
    git: null,
    failure: null,
  };

  const noOperator = { hit: null, searched: [], refusals: [] };

  it("states the model, the thinking level, the window and the subagent default right after the date", () => {
    const out = render({ ...base, operator: noOperator });
    assert.match(
      out,
      /## Today\n2026-08-07\n\n## Runtime\nmodel github-copilot\/claude-opus-5 · thinking high · context window 200000 tokens\n/,
    );
    assert.match(out, /Subagent default tier: light \(github-copilot\/claude-sonnet-5 @ medium\)\./);
    assert.match(
      out,
      /Routing questions are answered from config\/models\.json and config\/routing\.json, never from memory\./,
    );
  });

  it("renders the Runtime section loudly rather than omitting it when the model is unknown", () => {
    const out = render({
      ...base,
      operator: noOperator,
      live: { model: null, thinkingLevel: null, contextWindow: null, problem: "runtime exposed no model" },
    });
    assert.match(out, /## Runtime\nmodel UNRESOLVED — runtime exposed no model/);
    assert.match(out, /thinking UNRESOLVED · context window UNRESOLVED/);
    assert.match(out, /Say the model is unknown when asked; never name one from memory\./);
  });

  it("names the unresolvable subagent tier and why, instead of dropping the line", () => {
    const out = render({
      ...base,
      operator: noOperator,
      subagent: { tier: "light", model: null, thinkingLevel: null, problem: 'no tier "light"' },
    });
    assert.match(out, /Subagent default tier: light — UNRESOLVED: no tier "light"/);
  });

  it("keeps the block under the cap with the Runtime section and a full-budget operator file", () => {
    const out = render({
      ...base,
      operator: {
        hit: { path: "/x/OPERATOR.local.md", source: "personal overlay", text: "y".repeat(50_000) },
        searched: [],
        refusals: [],
      },
    });
    assert.match(out, /## Runtime/);
    assert.ok(Buffer.byteLength(injectOnce("", out), "utf8") <= MAX_BLOCK_BYTES);
  });

  it("announces an operator miss inside the block itself", () => {
    const out = render({
      ...base,
      operator: { hit: null, searched: ["/a — not found", "/b — not found"], refusals: [] },
    });
    assert.match(out, /## Today\n2026-08-07/);
    assert.match(out, /## Scratchpad\n\/state\/scratch\/s1/);
    assert.match(out, /Never write temporary files to \/tmp/);
    assert.match(out, /No operator-identity file resolved\. Searched, in order:/);
    assert.match(out, /- \/a — not found/);
    assert.match(out, /Proceed without operator context; do not invent one\./);
  });

  it("omits the Project section entirely outside a repo with no docs", () => {
    const out = render({ ...base, operator: { hit: null, searched: [], refusals: [] } });
    assert.equal(out.includes("## Project"), false);
  });

  it("renders branch, dirty count and log when git answered", () => {
    const out = render({
      ...base,
      operator: { hit: null, searched: [], refusals: [] },
      git: { branch: "feature/x", log: "abc1234 feat: one", dirty: 2 },
    });
    assert.match(out, /## Project\nbranch feature\/x, 2 uncommitted file\(s\)/);
    assert.match(out, /abc1234 feat: one/);
  });

  it("says 'not a git repository' when docs exist but git did not answer", () => {
    const out = render({
      ...base,
      operator: { hit: null, searched: [], refusals: [] },
      projectState: "state doc",
      architecture: "arch doc",
    });
    assert.match(out, /## Project\nnot a git repository/);
    assert.match(out, /### docs\/project_state\.md \(head 200\)\nstate doc/);
    assert.match(out, /### docs\/architecture\.md \(head 200\)\narch doc/);
  });

  it("caps a huge operator file and names the source so the full text is findable", () => {
    const out = render({
      ...base,
      operator: {
        hit: { path: "/x/OPERATOR.local.md", source: "personal overlay", text: "y".repeat(50_000) },
        searched: [],
        refusals: [],
      },
    });
    assert.match(out, /Source: \/x\/OPERATOR\.local\.md/);
    assert.match(out, /operator file truncated to 4096 bytes — full file at \/x\/OPERATOR\.local\.md/);
    assert.ok(Buffer.byteLength(out, "utf8") < MAX_BLOCK_BYTES);
  });

  it("surfaces a wholesale collect failure to the agent, not only to the log", () => {
    const out = render({
      ...base,
      failure: "scratchpad directory could not be created: Error[EACCES]: denied",
      operator: { hit: null, searched: [], refusals: [] },
    });
    assert.match(out, /## Session context \(degraded\)/);
    assert.match(out, /EACCES/);
  });
});

describe("readLiveModel", () => {
  it("reads provider, id, window and thinking level off the live context", () => {
    const live = readLiveModel({
      model: { provider: "github-copilot", id: "claude-opus-5", contextWindow: 200_000 },
      thinkingLevel: "high",
    });
    assert.deepEqual(live, {
      model: "github-copilot/claude-opus-5",
      thinkingLevel: "high",
      contextWindow: 200_000,
      problem: null,
    });
  });

  it("reports a problem — not a guess — when the runtime exposes no model", () => {
    const live = readLiveModel({ thinkingLevel: "high" });
    assert.equal(live.model, null);
    assert.equal(live.thinkingLevel, "high");
    assert.match(live.problem ?? "", /exposed no active model/);
  });

  it("turns a throwing context getter into a rendered problem", () => {
    const live = readLiveModel({
      get model(): never {
        throw new Error("runner is not active");
      },
    });
    assert.equal(live.model, null);
    assert.match(live.problem ?? "", /refused to report its model.*runner is not active/);
  });
});

describe("resolveSubagentDefault", () => {
  const settings = (tiers: Record<string, { model: string; thinkingLevel?: string }>, tier = "strong") =>
    ({
      dispatch: { defaultTier: tier },
      routing: { tiers },
      problems: [],
    }) as unknown as DispatchSettings;

  it("resolves the default tier through the routing table", () => {
    const out = resolveSubagentDefault(
      () => assert.fail("a resolvable tier must announce nothing"),
      settings({ strong: { model: "github-copilot/claude-opus-5", thinkingLevel: "high" } }),
    );
    assert.deepEqual(out, {
      tier: "strong",
      model: "github-copilot/claude-opus-5",
      thinkingLevel: "high",
      problem: null,
    });
  });

  it("announces AND renders an undeclared tier, listing the tiers that do exist", () => {
    const said: string[] = [];
    const out = resolveSubagentDefault(
      (line) => said.push(line),
      settings({ light: { model: "github-copilot/claude-sonnet-5" } }),
    );
    assert.equal(out.model, null);
    assert.match(out.problem ?? "", /declares no tier "strong" \(declared: light\)/);
    assert.equal(said.length, 1);
    assert.match(said[0] ?? "", /could not be resolved/);
  });
});

describe("collect — session_start I/O", () => {
  it("creates the scratchpad 0700 and gathers git facts", async () => {
    const dir = await mkdtemp(join(sandbox, "collect-"));
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.PI_CONFIG_REPO = join(dir, "repo");
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    delete process.env.PI_IDENTITY_PATH;
    delete process.env.PI_OPERATOR_FILE;
    await mkdir(join(dir, "cwd", "docs"), { recursive: true });
    await writeFile(join(dir, "cwd", "docs", "project_state.md"), "# state\nline2\n", "utf8");

    const { pi } = fakePi(GIT_OK);
    const { ctx } = fakeCtx({ cwd: join(dir, "cwd"), sessionId: "sess-1" });
    const { value: st } = await captureStderr(() => collect(pi, ctx, makeAnnounce(), 1));

    assert.equal(st.scratch, join(dir, "state", "pi-config", "scratch", "sess-1"));
    const info = await stat(st.scratch);
    assert.equal(info.isDirectory(), true);
    assert.equal((info.mode & 0o777).toString(8), "700");
    assert.equal(st.failure, null);
    assert.equal(st.dateKey, todayKey());
    assert.match(st.projectState, /# state/);
    assert.equal(st.architecture, "");
    assert.deepEqual(st.git, {
      branch: "feature/implement-waves",
      log: "abc1234 feat: one\ndef5678 fix: two",
      dirty: 2,
    });
  });

  it("returns null git — not an empty branch — outside a repository", async () => {
    const dir = await mkdtemp(join(sandbox, "collect-norepo-"));
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.PI_CONFIG_REPO = join(dir, "repo");
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    const { pi } = fakePi(GIT_NOT_A_REPO);
    const { ctx } = fakeCtx({ cwd: dir, sessionId: "sess-2" });
    const { value: st, lines } = await captureStderr(() => collect(pi, ctx, makeAnnounce(), 1));
    assert.equal(st.git, null);
    assert.equal(render(st).includes("## Project"), false);
    assert.equal(
      lines.some((l) => l.includes("git")),
      false,
      "a non-repo directory is normal and must not be announced as a fault",
    );
  });

  it("drops git and announces when `git status` fails inside a repo", async () => {
    const dir = await mkdtemp(join(sandbox, "collect-gitfail-"));
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.PI_CONFIG_REPO = join(dir, "repo");
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    const { pi } = fakePi({
      ...GIT_OK,
      "status --porcelain": { code: 128, stderr: "fatal: index.lock exists" },
    });
    const { ctx } = fakeCtx({ cwd: dir, sessionId: "sess-3" });
    const { value: st, lines } = await captureStderr(() => collect(pi, ctx, makeAnnounce(), 1));
    assert.equal(st.git, null);
    assert.ok(lines.some((l) => l.includes("git status failed")));
    assert.ok(lines.some((l) => l.includes("index.lock")));
  });

  it("tolerates a repository with no commits yet", async () => {
    const dir = await mkdtemp(join(sandbox, "collect-empty-"));
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.PI_CONFIG_REPO = join(dir, "repo");
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    const { pi } = fakePi({
      "rev-parse --is-inside-work-tree": { stdout: "true\n" },
      "branch --show-current": { stdout: "main\n" },
      "log -5 --oneline --no-decorate": { code: 128, stderr: "does not have any commits yet" },
      "status --porcelain": { stdout: "" },
    });
    const { ctx } = fakeCtx({ cwd: dir, sessionId: "sess-4" });
    const { value: st } = await captureStderr(() => collect(pi, ctx, makeAnnounce(), 1));
    assert.deepEqual(st.git, { branch: "main", log: "(no commit history)", dirty: 0 });
  });

  it("takes only the head of an oversized project doc and announces the cut", async () => {
    const dir = await mkdtemp(join(sandbox, "collect-big-"));
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.PI_CONFIG_REPO = join(dir, "repo");
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    await mkdir(join(dir, "cwd", "docs"), { recursive: true });
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"z".repeat(60)}`).join("\n");
    await writeFile(join(dir, "cwd", "docs", "project_state.md"), big, "utf8");

    const { pi } = fakePi(GIT_NOT_A_REPO);
    const { ctx } = fakeCtx({ cwd: join(dir, "cwd"), sessionId: "sess-5" });
    const { value: st } = await captureStderr(() => collect(pi, ctx, makeAnnounce(), 1));
    assert.ok(Buffer.byteLength(st.projectState, "utf8") <= 1024 + 64);
    assert.match(st.projectState, /truncated to 1024 bytes/);
    assert.match(st.projectState, /^line 0 /);
    assert.equal(st.projectState.includes("line 300 "), false, "head-200 only");
  });

  it("sanitises a hostile session id into a single path segment", async () => {
    const dir = await mkdtemp(join(sandbox, "collect-evil-"));
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.PI_CONFIG_REPO = join(dir, "repo");
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    const { pi } = fakePi(GIT_NOT_A_REPO);
    const { ctx } = fakeCtx({ cwd: dir, sessionId: "../../escape" });
    const { value: st } = await captureStderr(() => collect(pi, ctx, makeAnnounce(), 1));
    const root = join(dir, "state", "pi-config", "scratch");
    assert.ok(st.scratch.startsWith(`${root}/`), st.scratch);
    const segment = st.scratch.slice(root.length + 1);
    assert.equal(segment.includes("/"), false);
    assert.equal(segment.includes(".."), false);
    assert.equal((await stat(st.scratch)).isDirectory(), true);
  });
});

describe("register — event wiring", () => {
  async function boot(options: { execTable?: Record<string, ExecReply>; cwd?: string } = {}) {
    const dir = await mkdtemp(join(sandbox, "boot-"));
    process.env.XDG_STATE_HOME = join(dir, "state");
    process.env.PI_CONFIG_REPO = join(dir, "repo");
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    delete process.env.PI_IDENTITY_PATH;
    delete process.env.PI_OPERATOR_FILE;
    const harness = fakePi(options.execTable ?? GIT_NOT_A_REPO);
    const c = fakeCtx({ cwd: options.cwd ?? dir, sessionId: "boot-session" });
    register(harness.pi);
    return { dir, ...harness, ...c };
  }

  const fire = async (
    handlers: Map<string, Array<(e: unknown, c: unknown) => unknown>>,
    event: string,
    payload: unknown,
    ctx: unknown,
  ): Promise<unknown[]> => {
    const out: unknown[] = [];
    for (const h of handlers.get(event) ?? []) out.push(await h(payload, ctx));
    return out;
  };

  it("registers exactly the events and the command the spec names", async () => {
    const h = await boot();
    assert.deepEqual(
      [...h.handlers.keys()].sort(),
      ["before_agent_start", "session_compact", "session_start"],
    );
    assert.deepEqual([...h.commands.keys()], ["ctx-dump"]);
  });

  it("injects nothing before session_start has run", async () => {
    const h = await boot();
    const results = await fire(
      h.handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE" },
      h.ctx,
    );
    assert.deepEqual(results, [undefined]);
  });

  it("exports PI_SCRATCH_DIR and injects one block after session_start", async () => {
    const h = await boot();
    await captureStderr(() =>
      fire(h.handlers, "session_start", { type: "session_start", reason: "startup" } as SessionStartEvent, h.ctx),
    );
    assert.equal(process.env.PI_SCRATCH_DIR, __state()?.scratch);
    assert.ok(process.env.PI_SCRATCH_DIR?.includes("boot-session"));

    const [result] = (await fire(
      h.handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "hi", systemPrompt: "BASE" },
      h.ctx,
    )) as Array<{ systemPrompt: string } | undefined>;
    assert.ok(result);
    assert.equal(countMarkerLines(result.systemPrompt), 2);
    assert.match(result.systemPrompt, /^BASE/);
    assert.match(result.systemPrompt, new RegExp(`## Today\\n${todayKey()}`));
  });

  it("stays at one block across three compactions — the requirement that killed the predecessor", async () => {
    const h = await boot();
    await captureStderr(() =>
      fire(h.handlers, "session_start", { type: "session_start", reason: "startup" }, h.ctx),
    );
    let prompt = "BASE";
    for (let i = 0; i < 3; i++) {
      const [r] = (await fire(
        h.handlers,
        "before_agent_start",
        { type: "before_agent_start", prompt: "p", systemPrompt: prompt },
        h.ctx,
      )) as Array<{ systemPrompt: string }>;
      prompt = r.systemPrompt;
      await fire(h.handlers, "session_compact", { type: "session_compact", reason: "manual" }, h.ctx);
    }
    const [last] = (await fire(
      h.handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "p", systemPrompt: prompt },
      h.ctx,
    )) as Array<{ systemPrompt: string }>;
    assert.equal(countMarkerLines(last.systemPrompt), 2);
  });

  it("re-arms on a second session_start: new scratch dir, new epoch, fresh announcement", async () => {
    const h = await boot();
    const first = await captureStderr(() =>
      fire(h.handlers, "session_start", { type: "session_start", reason: "startup" }, h.ctx),
    );
    const epoch1 = __state()?.epoch;
    assert.ok(first.lines.some((l) => l.includes("no operator-identity file resolved (startup)")));

    const second = await captureStderr(() =>
      fire(h.handlers, "session_start", { type: "session_start", reason: "resume" }, h.ctx),
    );
    assert.equal(__state()?.epoch, (epoch1 ?? 0) + 1);
    assert.ok(second.lines.some((l) => l.includes("no operator-identity file resolved (resume)")));
  });

  it("recomputes the date on a rollover and only then", async () => {
    const h = await boot();
    await captureStderr(() =>
      fire(h.handlers, "session_start", { type: "session_start", reason: "startup" }, h.ctx),
    );
    const st = __state();
    assert.ok(st);
    st.dateKey = "1999-01-01";
    const [r] = (await fire(
      h.handlers,
      "before_agent_start",
      { type: "before_agent_start", prompt: "p", systemPrompt: "BASE" },
      h.ctx,
    )) as Array<{ systemPrompt: string }>;
    assert.equal(st.dateKey, todayKey());
    assert.match(r.systemPrompt, new RegExp(`## Today\\n${todayKey()}`));
    assert.equal(r.systemPrompt.includes("1999-01-01"), false);
  });

  it("fails OPEN and announces once when injection itself throws", async () => {
    const h = await boot();
    await captureStderr(() =>
      fire(h.handlers, "session_start", { type: "session_start", reason: "startup" }, h.ctx),
    );
    const { lines } = await captureStderr(async () => {
      const results: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        // `systemPrompt` is not a string, so `indexOf` inside stripBlock throws.
        results.push(
          ...(await fire(
            h.handlers,
            "before_agent_start",
            { type: "before_agent_start", prompt: "p", systemPrompt: undefined },
            h.ctx,
          )),
        );
      }
      return results;
    });
    assert.equal(
      lines.filter((l) => l.includes("injection failed")).length,
      1,
      "surfaced exactly once, not once per prompt",
    );
  });

  it("/ctx-dump writes a prompt carrying exactly one block, before any turn has run", async () => {
    const h = await boot();
    await captureStderr(() =>
      fire(h.handlers, "session_start", { type: "session_start", reason: "startup" }, h.ctx),
    );
    const cmd = h.commands.get("ctx-dump");
    assert.ok(cmd);
    // fakeCtx() sets hasUI:false, so `lib/announce.ts` routes the confirmation through the log
    // sink (stderr here), not `ctx.ui.notify` — `h.notifications` would stay empty by design.
    const { lines } = await captureStderr(() => cmd.handler("", h.ctx));
    const out = join(__state()?.scratch ?? "", "system-prompt.txt");
    const text = await readFile(out, "utf8");
    assert.equal(countMarkerLines(text), 2);
    assert.match(text, /^BASE PROMPT/);
    assert.match(text, /## Scratchpad/);
    assert.ok(lines.some((l) => l.includes("system prompt written to")));
  });

  it("/ctx-dump fails loud with the cause chain when the write is impossible", async () => {
    const h = await boot();
    await captureStderr(() =>
      fire(h.handlers, "session_start", { type: "session_start", reason: "startup" }, h.ctx),
    );
    const st = __state();
    assert.ok(st);
    // A file where the directory must be: mkdir -> ENOTDIR / EEXIST.
    await rm(st.scratch, { recursive: true, force: true });
    await writeFile(st.scratch, "not a directory", "utf8");
    const cmd = h.commands.get("ctx-dump");
    assert.ok(cmd);
    await assert.rejects(
      () => cmd.handler("", h.ctx) as Promise<void>,
      (err: Error) => {
        assert.match(err.message, /\/ctx-dump could not write/);
        assert.ok(err.cause instanceof Error, "the cause chain is preserved");
        return true;
      },
    );
  });
});
