import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  execHook,
  normalizeDecision,
  resetHookCache,
} from "../../extensions/lib/exec-hook.ts";
import { resetSurfaced } from "../../extensions/lib/once.ts";

let dir: string;

/** Writes an executable bash hook and returns its path. */
async function hook(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, `#!/usr/bin/env bash\nset -u\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

const DENY_ENVELOPE =
  `'{"hookSpecificOutput":{"hookEventName":"PreToolUse",` +
  `"permissionDecision":"deny","permissionDecisionReason":"secret path"}}'`;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-exechook-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  resetHookCache();
  resetSurfaced();
});

describe("execHook — the payload actually arrives on stdin", () => {
  it("a Claude-Code-shaped script reads stdin and its deny envelope is understood", async () => {
    // The shape of protect-secrets.sh: `INPUT=$(cat)`, then a hookSpecificOutput envelope.
    const script = await hook(
      "protect.sh",
      `INPUT=$(cat)\ncase "$INPUT" in\n  *".env"*) printf '%s' ${DENY_ENVELOPE} ;;\n  *) exit 0 ;;\nesac`,
    );

    const denied = await execHook(null, script, {
      tool_name: "Read",
      tool_input: { file_path: "/repo/.env" },
    });
    assert.deepEqual(denied, { decision: "deny", reason: "secret path" });

    const allowed = await execHook(null, script, {
      tool_name: "Read",
      tool_input: { file_path: "/repo/README.md" },
    });
    assert.deepEqual(allowed, {}, "no opinion, which the caller must not read as allow");
  });

  it("the payload arrives byte-identical to JSON.stringify, with no trailing newline", async () => {
    const script = await hook(
      "size.sh",
      `INPUT=$(cat)\nprintf '{"reason":"%s"}' "$(printf '%s' "$INPUT" | wc -c | tr -d ' ')"`,
    );
    const payload = { tool_name: "Bash", tool_input: { command: "ls -la /repo" } };
    const res = await execHook(null, script, payload);
    assert.equal(res.reason, String(JSON.stringify(payload).length));
  });
});

describe("execHook — fail-open matrix", () => {
  it("missing script returns no opinion", async () => {
    assert.deepEqual(await execHook(null, join(dir, "does-not-exist.sh"), {}), {});
  });

  it("non-executable script returns no opinion and is surfaced once", async () => {
    const p = join(dir, "not-exec.sh");
    await writeFile(p, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(p, 0o644);
    const lines: string[] = [];
    assert.deepEqual(await execHook(null, p, {}, { onError: (l) => void lines.push(l) }), {});
    assert.equal(lines.length, 1);
    assert.match(lines[0], /not executable/);
  });

  it("timeout kills the script and returns no opinion", async () => {
    const script = await hook("slow.sh", "exec sleep 5");
    const lines: string[] = [];
    const started = Date.now();
    const res = await execHook(null, script, {}, { timeoutMs: 300, onError: (l) => void lines.push(l) });
    const elapsed = Date.now() - started;

    assert.deepEqual(res, {});
    assert.ok(elapsed < 2500, `timeout must be enforced in Node; took ${elapsed} ms`);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /exceeded 300 ms/);
  });

  it("exit 1 returns no opinion and is surfaced once with its stderr", async () => {
    const script = await hook("broken.sh", 'echo "jq: command not found" >&2\nexit 1');
    const lines: string[] = [];
    assert.deepEqual(await execHook(null, script, {}, { onError: (l) => void lines.push(l) }), {});
    assert.equal(lines.length, 1);
    assert.match(lines[0], /exited 1/);
    assert.match(lines[0], /jq: command not found/);
  });

  it("exit 127 (a missing interpreter or helper) returns no opinion", async () => {
    const script = await hook("missing-helper.sh", "definitely-not-a-command\nexit $?");
    assert.deepEqual(await execHook(null, script, {}, { onError: () => {} }), {});
  });

  it("garbage stdout returns no opinion and is surfaced once", async () => {
    const script = await hook("garbage.sh", 'echo "this is not json"');
    const lines: string[] = [];
    assert.deepEqual(await execHook(null, script, {}, { onError: (l) => void lines.push(l) }), {});
    assert.equal(lines.length, 1);
    assert.match(lines[0], /non-JSON stdout/);
  });

  it("empty stdout with exit 0 returns no opinion silently", async () => {
    const script = await hook("quiet.sh", "exit 0");
    const lines: string[] = [];
    assert.deepEqual(await execHook(null, script, {}, { onError: (l) => void lines.push(l) }), {});
    assert.deepEqual(lines, [], "a hook with no opinion is the normal case, not an error");
  });

  it("a script that exits without reading stdin does not produce an EPIPE failure", async () => {
    const script = await hook("early-exit.sh", "exit 0");
    const lines: string[] = [];
    const big = { tool_input: { command: "x".repeat(200_000) } };
    assert.deepEqual(await execHook(null, script, big, { onError: (l) => void lines.push(l) }), {});
    assert.deepEqual(lines, []);
  });
});

describe("execHook — exit code 2", () => {
  it("exit 2 blocks with stderr as the reason (Claude Code's contract)", async () => {
    const script = await hook("block2.sh", 'echo "rm -rf / is never ok" >&2\nexit 2');
    assert.deepEqual(await execHook(null, script, {}), {
      decision: "deny",
      reason: "rm -rf / is never ok",
    });
  });

  it("exit 2 with no stderr still blocks, with a synthesised reason", async () => {
    const script = await hook("block2-quiet.sh", "exit 2");
    const res = await execHook(null, script, {});
    assert.equal(res.decision, "deny");
    assert.match(res.reason ?? "", /exit 2, no reason given/);
  });
});

describe("execHook — memoisation of an unusable script", () => {
  it("a script found missing is not looked at again until the cache is reset", async () => {
    const p = join(dir, "appears-later.sh");
    assert.deepEqual(await execHook(null, p, {}), {}, "first call: genuinely missing");

    await writeFile(p, `#!/usr/bin/env bash\nprintf '%s' '{"decision":"deny","reason":"now here"}'\n`);
    await chmod(p, 0o755);
    assert.deepEqual(await execHook(null, p, {}), {}, "memoised: the file is not re-checked");

    resetHookCache();
    assert.deepEqual(await execHook(null, p, {}), { decision: "deny", reason: "now here" });
  });

  it("100 calls on a missing script stay on the fast path", async () => {
    const p = join(dir, "never.sh");
    const started = Date.now();
    for (let i = 0; i < 100; i++) assert.deepEqual(await execHook(null, p, {}), {});
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 200, `100 memoised misses took ${elapsed} ms; a spawn each would be seconds`);
  });
});

describe("normalizeDecision", () => {
  it("maps hookSpecificOutput", () => {
    assert.deepEqual(
      normalizeDecision({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "why",
        },
      }),
      { decision: "deny", reason: "why" },
    );
  });

  it("maps the additionalContext channel", () => {
    assert.deepEqual(
      normalizeDecision({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "today is X" },
      }),
      { additionalContext: "today is X" },
    );
  });

  it("maps the legacy flat approve/block vocabulary", () => {
    assert.deepEqual(normalizeDecision({ decision: "block", reason: "no" }), {
      decision: "deny",
      reason: "no",
    });
    assert.deepEqual(normalizeDecision({ decision: "approve" }), { decision: "allow" });
  });

  it("passes an already-normalised decision through", () => {
    assert.deepEqual(normalizeDecision({ decision: "ask", reason: "unsure" }), {
      decision: "ask",
      reason: "unsure",
    });
  });

  it("ignores unknown verbs and non-objects rather than guessing", () => {
    assert.deepEqual(normalizeDecision({ decision: "maybe" }), {});
    assert.deepEqual(normalizeDecision("deny"), {});
    assert.deepEqual(normalizeDecision(null), {});
    assert.deepEqual(normalizeDecision([1, 2]), {});
  });
});

/**
 * REQ-EXT-25's literal acceptance criterion: the same `protect-secrets.sh` file, UNMODIFIED,
 * produces a deny in both Claude Code and PI when fed the same JSON payload. It reads a file
 * outside the repo, so it is opt-in: PI_CONFIG_TEST_CC_HOOKS=1.
 */
describe("REQ-EXT-25 — the real Claude Code hook scripts, unmodified", () => {
  const enabled = process.env.PI_CONFIG_TEST_CC_HOOKS === "1";
  const protectSecrets = join(homedir(), ".claude", "hooks", "protect-secrets.sh");
  const blockBash = join(homedir(), ".claude", "hooks", "block-dangerous-bash.sh");

  it("protect-secrets.sh denies a .env read and allows .env.example", { skip: !enabled }, async () => {
    assert.ok(existsSync(protectSecrets), `${protectSecrets} not found`);
    const denied = await execHook(null, protectSecrets, {
      tool_name: "Read",
      tool_input: { file_path: "/repo/.env" },
    });
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason ?? "", /protect-secrets/);

    const allowed = await execHook(null, protectSecrets, {
      tool_name: "Read",
      tool_input: { file_path: "/repo/.env.example" },
    });
    assert.deepEqual(allowed, {});
  });

  it("block-dangerous-bash.sh denies rm -fr / and allows rm -rf ./build", { skip: !enabled }, async () => {
    assert.ok(existsSync(blockBash), `${blockBash} not found`);
    const denied = await execHook(null, blockBash, {
      tool_name: "Bash",
      tool_input: { command: "rm -fr /" },
    });
    assert.equal(denied.decision, "deny");

    const allowed = await execHook(null, blockBash, {
      tool_name: "Bash",
      tool_input: { command: "rm -rf ./build" },
    });
    assert.deepEqual(allowed, {});
  });
});
