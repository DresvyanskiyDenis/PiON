import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runGuardScript } from "../../extensions/hooks/run.ts";

let dir: string;

async function script(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, `#!/usr/bin/env bash\nset -u\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-hooks-run-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("runGuardScript — the fail-closed matrix (the opposite of exec-hook.ts)", () => {
  it("a missing script BLOCKS (never no-opinion)", async () => {
    const outcome = await runGuardScript(join(dir, "does-not-exist.sh"), [], {});
    assert.equal(outcome.verdict, "blocked-internal");
    assert.match((outcome as { reason: string }).reason, /missing or not executable/);
  });

  it("a non-executable script BLOCKS", async () => {
    const p = join(dir, "not-exec.sh");
    await writeFile(p, "#!/usr/bin/env bash\nexit 0\n");
    await chmod(p, 0o644);
    const outcome = await runGuardScript(p, [], {});
    assert.equal(outcome.verdict, "blocked-internal");
  });

  it("a script that times out BLOCKS", async () => {
    const p = await script("slow.sh", "sleep 5");
    const outcome = await runGuardScript(p, [], {}, { timeoutMs: 150 });
    assert.equal(outcome.verdict, "blocked-internal");
    assert.match((outcome as { reason: string }).reason, /exceeded 150 ms/);
  });

  it("exit code 2 denies, using stderr as the reason", async () => {
    const p = await script("deny2.sh", 'echo "no bash today" >&2\nexit 2');
    const outcome = await runGuardScript(p, [], {});
    assert.deepEqual(outcome, { verdict: "deny", reason: "no bash today" });
  });

  it('exit 0 with {"decision":"deny",...} JSON denies', async () => {
    const p = await script("denyjson.sh", 'printf \'{"decision":"deny","reason":"policy"}\'');
    const outcome = await runGuardScript(p, [], {});
    assert.deepEqual(outcome, { verdict: "deny", reason: "policy" });
  });

  it("exit 0 with empty stdout is a genuine no-opinion, not a failure", async () => {
    const p = await script("silent.sh", "exit 0");
    const outcome = await runGuardScript(p, [], {});
    assert.deepEqual(outcome, { verdict: "no-opinion" });
  });

  it("exit 0 with non-JSON stdout BLOCKS rather than guessing", async () => {
    const p = await script("garbage.sh", "printf 'not json at all'");
    const outcome = await runGuardScript(p, [], {});
    assert.equal(outcome.verdict, "blocked-internal");
    assert.match((outcome as { reason: string }).reason, /non-JSON stdout/);
  });

  it("an unexpected non-zero, non-2 exit code BLOCKS", async () => {
    const p = await script("crash.sh", 'echo "boom" >&2\nexit 17');
    const outcome = await runGuardScript(p, [], {});
    assert.equal(outcome.verdict, "blocked-internal");
    assert.match((outcome as { reason: string }).reason, /exited 17/);
  });

  it("exit 0 with {\"decision\":\"allow\"} is still just a no-opinion, not an override", async () => {
    const p = await script("allow.sh", 'printf \'{"decision":"allow"}\'');
    const outcome = await runGuardScript(p, [], {});
    assert.deepEqual(outcome, { verdict: "no-opinion" });
  });

  it("the payload arrives on stdin as JSON", async () => {
    const p = await script(
      "echo-len.sh",
      `INPUT=$(cat)\nprintf '{"decision":"deny","reason":"%s"}' "$(printf '%s' "$INPUT" | wc -c | tr -d ' ')"`,
    );
    const payload = { event: "tool_call", tool: "bash", input: { command: "ls" } };
    const outcome = await runGuardScript(p, [], payload);
    assert.equal(outcome.verdict, "deny");
    assert.equal((outcome as { reason: string }).reason, String(JSON.stringify(payload).length));
  });
});
