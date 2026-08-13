// EXT-13 (b) — `config/bin/dbx-token-cached`, the TTL cache in front of Databricks OAuth.
//
// Why it exists at all: pi resolves an `"apiKey": "!command"` credential AT REQUEST TIME, on
// every single request, and applies no TTL, stale reuse or recovery of its own. An unwrapped
// `databricks auth token` is therefore one OAuth round trip per LLM call.
//
// Every test here drives the real script with a stub `databricks` on PATH and its own cache dir.
// Nothing touches ~/.cache/pi, nothing reaches the network, and no real credential is involved.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SCRIPT = fileURLToPath(new URL("../config/bin/dbx-token-cached", import.meta.url));

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Harness {
  readonly dir: string;
  readonly cacheDir: string;
  readonly callsFile: string;
  readonly binDir: string;
}

/**
 * A stub `databricks` that records every invocation and answers with a token + expiry taken from
 * the environment, so each test controls the CLI's behaviour without a real Databricks account.
 */
async function harness(options: { delaySeconds?: number; failWith?: string } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "pi-ext13-dbx-"));
  const cacheDir = join(dir, "cache");
  const binDir = join(dir, "bin");
  const callsFile = join(dir, "calls.log");
  await mkdir(binDir, { recursive: true });
  await writeFile(callsFile, "", "utf8");

  const body = [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> "${callsFile}"`,
    options.delaySeconds ? `sleep ${options.delaySeconds}` : "",
    options.failWith
      ? `printf '%s\\n' ${JSON.stringify(options.failWith)} >&2; exit 7`
      : `printf '{"access_token":"%s","expiry":"%s"}' "$STUB_TOKEN" "$STUB_EXPIRY"`,
    "",
  ].join("\n");
  const stubPath = join(binDir, "databricks");
  await writeFile(stubPath, body, "utf8");
  await chmod(stubPath, 0o755);

  return { dir, cacheDir, callsFile, binDir };
}

function run(
  h: Harness,
  env: Record<string, string> = {},
  argv: string[] = [SCRIPT],
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", argv, {
      env: {
        ...process.env,
        PATH: `${h.binDir}:${process.env.PATH ?? ""}`,
        PI_DBX_CACHE_DIR: h.cacheDir,
        DATABRICKS_HOST: "https://example-workspace.invalid",
        STUB_TOKEN: "dapiSTUBnotArealPatValue00000001",
        STUB_EXPIRY: isoIn(3600),
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function callCount(h: Harness): Promise<number> {
  const text = await readFile(h.callsFile, "utf8");
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

async function cacheJson(h: Harness): Promise<{ token: string; expires_epoch: number }> {
  const files = (await readdir(h.cacheDir)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1, `expected one cache file, found ${files.join(", ") || "none"}`);
  return JSON.parse(await readFile(join(h.cacheDir, files[0] as string), "utf8"));
}

/* ------------------------------------------------------------------------------------------- */

describe("mode (a) — PAT passthrough", () => {
  it("echoes DATABRICKS_TOKEN with no network, no cache and no CLI invocation", async () => {
    const h = await harness();
    const result = await run(h, { DATABRICKS_TOKEN: "dapiPATVALUE" });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "dapiPATVALUE");
    assert.equal(await callCount(h), 0);
  });

  it("trims a trailing newline — a PAT pasted from a .env would otherwise go into the header", async () => {
    const h = await harness();
    const result = await run(h, { DATABRICKS_TOKEN: "dapiPATVALUE\n" });
    assert.equal(result.stdout, "dapiPATVALUE");
  });

  it("fails loudly when DATABRICKS_TOKEN is whitespace-only rather than sending an empty header", async () => {
    const h = await harness();
    const result = await run(h, { DATABRICKS_TOKEN: "\n" });
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
  });
});

describe("profile selection", () => {
  // `--host` is not a selector: a ~/.databrickscfg with several profiles pointing at the same
  // workspace makes the real CLI abort with "... match <host> in ~/.databrickscfg. Use --profile".
  // The script must therefore always name a profile, and it must be the same one the cache key is
  // derived from, or a warm cache would serve a token minted for a different profile.
  it("passes --profile DEFAULT when DATABRICKS_CONFIG_PROFILE is unset", async () => {
    const h = await harness();
    const result = await run(h);
    assert.equal(result.code, 0);
    const calls = await readFile(h.callsFile, "utf8");
    assert.match(calls, /(^|\s)--profile DEFAULT(\s|$)/m);
  });

  it("passes the explicit profile when DATABRICKS_CONFIG_PROFILE is set", async () => {
    const h = await harness();
    const result = await run(h, { DATABRICKS_CONFIG_PROFILE: "prod_coc_oauth" });
    assert.equal(result.code, 0);
    const calls = await readFile(h.callsFile, "utf8");
    assert.match(calls, /(^|\s)--profile prod_coc_oauth(\s|$)/m);
  });

  it("caches per profile, so two profiles never share one token", async () => {
    const h = await harness();
    await run(h, { DATABRICKS_CONFIG_PROFILE: "one", STUB_TOKEN: "dapiONE" });
    await run(h, { DATABRICKS_CONFIG_PROFILE: "two", STUB_TOKEN: "dapiTWO" });
    const second = await run(h, { DATABRICKS_CONFIG_PROFILE: "one", STUB_TOKEN: "dapiIGNORED" });
    assert.equal(second.stdout, "dapiONE", "profile 'one' must hit its own cache entry");
    assert.equal(await callCount(h), 2, "one fetch per profile, not per call");
  });
});

describe("mode (b) — fetch, cache, reuse", () => {
  it("fetches once, then serves from cache", async () => {
    const h = await harness();
    const first = await run(h);
    assert.equal(first.code, 0);
    assert.equal(first.stdout, "dapiSTUBnotArealPatValue00000001");
    assert.equal(await callCount(h), 1);

    for (let i = 0; i < 5; i++) {
      const again = await run(h);
      assert.equal(again.stdout, first.stdout);
    }
    assert.equal(await callCount(h), 1, "a warm cache must not re-invoke the CLI");
  });

  it("N concurrent callers produce ONE fetch and N identical tokens (REQ-PRV-14)", async () => {
    const h = await harness({ delaySeconds: 0.4 });
    const results = await Promise.all(Array.from({ length: 8 }, () => run(h)));
    const tokens = new Set(results.map((r) => r.stdout));
    assert.deepEqual([...tokens], ["dapiSTUBnotArealPatValue00000001"]);
    assert.ok(results.every((r) => r.code === 0));
    assert.equal(await callCount(h), 1, "the mkdir lock must collapse the stampede to one fetch");

    const counts = (await readdir(h.cacheDir)).filter((f) => f.endsWith(".count"));
    assert.equal(counts.length, 1);
    assert.equal((await readFile(join(h.cacheDir, counts[0] as string), "utf8")).trim(), "1");
  });

  it("refetches once the cached token is inside the skew window", async () => {
    const h = await harness();
    // The cache is valid while `now < expiry - skew`. A token 400 s from expiry is usable at the
    // default 300 s skew (100 s of margin left) and unusable at a 420 s skew, which puts the
    // usable-until instant 20 s in the past. 380 would NOT do it — that still leaves 20 s.
    await run(h, { STUB_EXPIRY: isoIn(400) });
    assert.equal(await callCount(h), 1);
    await run(h, { STUB_EXPIRY: isoIn(400) });
    assert.equal(await callCount(h), 1, "still 100 s clear of the default skew — no refetch");
    await run(h, { STUB_EXPIRY: isoIn(400), PI_DBX_SKEW: "420" });
    assert.equal(await callCount(h), 2, "inside the skew window the cache must be refused");
  });

  it("keeps one cache per (host, profile) so switching workspaces cannot cross tokens", async () => {
    const h = await harness();
    await run(h, { DATABRICKS_HOST: "https://a.invalid", STUB_TOKEN: "token-a" });
    await run(h, { DATABRICKS_HOST: "https://b.invalid", STUB_TOKEN: "token-b" });
    const files = (await readdir(h.cacheDir)).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 2);
    const back = await run(h, { DATABRICKS_HOST: "https://a.invalid", STUB_TOKEN: "ignored" });
    assert.equal(back.stdout, "token-a");
  });
});

describe("expiry parsing", () => {
  it("honours a numeric UTC offset instead of reading it as UTC wall clock", async () => {
    // The bug this pins: BSD `date -j -u -f '%Y-%m-%dT%H:%M:%S'` does not consume "+02:00" — it
    // warns and returns the wall clock as if it were UTC, i.e. two hours LATE. A token would
    // then be served for two hours after it stopped working.
    const h = await harness();
    const trueEpoch = Math.floor(Date.now() / 1000) + 3600;
    const utc = new Date(trueEpoch * 1000);
    const shifted = new Date((trueEpoch + 2 * 3600) * 1000);
    const iso = `${shifted.toISOString().replace(/\.\d+Z$/, "")}+02:00`;

    await run(h, { STUB_EXPIRY: iso });
    const cached = await cacheJson(h);
    assert.ok(
      Math.abs(cached.expires_epoch - Math.floor(utc.getTime() / 1000)) <= 1,
      `expected ~${Math.floor(utc.getTime() / 1000)}, got ${cached.expires_epoch} (offset ignored?)`,
    );
  });

  it("parses a plain Z timestamp with fractional seconds", async () => {
    const h = await harness();
    const target = Math.floor(Date.now() / 1000) + 1800;
    await run(h, { STUB_EXPIRY: new Date(target * 1000).toISOString() });
    const cached = await cacheJson(h);
    assert.ok(Math.abs(cached.expires_epoch - target) <= 1);
  });

  it("clamps an already-past expiry to the fallback TTL instead of caching a dead token", async () => {
    const h = await harness();
    const result = await run(h, { STUB_EXPIRY: isoIn(-7200), PI_DBX_TTL_FALLBACK: "1234" });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /implausible expiry/);
    const cached = await cacheJson(h);
    const expected = Math.floor(Date.now() / 1000) + 1234;
    assert.ok(Math.abs(cached.expires_epoch - expected) <= 5);
  });

  it("clamps an absurdly distant expiry the same way", async () => {
    const h = await harness();
    const result = await run(h, { STUB_EXPIRY: isoIn(400_000), PI_DBX_TTL_FALLBACK: "999" });
    assert.match(result.stderr, /implausible expiry/);
    const cached = await cacheJson(h);
    assert.ok(Math.abs(cached.expires_epoch - (Math.floor(Date.now() / 1000) + 999)) <= 5);
  });

  it("falls back when the CLI sends no expiry at all", async () => {
    const h = await harness();
    await run(h, { STUB_EXPIRY: "", PI_DBX_TTL_FALLBACK: "600" });
    const cached = await cacheJson(h);
    assert.ok(Math.abs(cached.expires_epoch - (Math.floor(Date.now() / 1000) + 600)) <= 5);
  });
});

describe("failure modes are loud and empty-stdout", () => {
  it("kills a hung `databricks auth token` at the timeout", { timeout: 30_000 }, async () => {
    // A U2M OAuth flow waits on a browser. pi re-runs this script per request, so an unbounded
    // wait here is an unbounded hang of the agent.
    const h = await harness({ delaySeconds: 10 });
    const started = Date.now();
    const result = await run(h, { PI_DBX_FETCH_TIMEOUT: "1" });
    const elapsed = Date.now() - started;
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /did not finish within 1s/);
    assert.ok(elapsed < 8_000, `expected the watchdog to fire, took ${elapsed} ms`);
  });

  it("exits non-zero with empty stdout when the CLI fails", async () => {
    const h = await harness({ failWith: "Error: cannot resolve host" });
    const result = await run(h);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /databricks auth token failed \(exit 7\)/);
  });

  it("never prints credential material to stderr, even when the CLI does", async () => {
    // The acceptance test, as a unit test: the grep is
    // `dapi|ey[A-Za-z0-9_-]{20,}` against everything this script writes to stderr.
    const leak =
      "auth failed for dapiDEADBEEFDEADBEEFDEADBEEF and " +
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc";
    const h = await harness({ failWith: leak });
    const result = await run(h);
    assert.doesNotMatch(result.stderr, /dapi/);
    assert.doesNotMatch(result.stderr, /ey[A-Za-z0-9_-]{20,}/);
    assert.match(result.stderr, /<redacted-pat>/);
    assert.match(result.stderr, /<redacted-jwt>/);
  });

  it("leaks nothing under an inherited xtrace", async () => {
    const h = await harness();
    const result = await run(h, {}, ["-x", SCRIPT]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "dapiSTUBnotArealPatValue00000001");
    assert.doesNotMatch(result.stderr, /dapiSTUBnotArealPat/);
  });

  it("fails when the databricks CLI is absent, rather than returning an empty token", async () => {
    const h = await harness();
    const result = await run(h, { PATH: "/usr/bin:/bin" });
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /no \$DATABRICKS_TOKEN and no 'databricks' CLI|jq is required/);
  });
});

describe("locking", () => {
  it("breaks an abandoned lock instead of waiting it out forever", async () => {
    const h = await harness();
    await mkdir(h.cacheDir, { recursive: true });
    // Reproduce the key the script derives for this (host, profile) pair.
    const key = "https://example-workspace.invalid|DEFAULT".replace(/[^A-Za-z0-9._-]/g, "_");
    const lock = join(h.cacheDir, `dbx-token-${key}.lock`);
    await mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 600_000);
    await utimes(lock, old, old);

    const started = Date.now();
    const result = await run(h, { PI_DBX_LOCK_STALE: "60" });
    const elapsed = Date.now() - started;
    assert.equal(result.code, 0);
    assert.match(result.stderr, /removed a stale lock/);
    assert.ok(elapsed < 10_000, `a stale lock must not cost the full retry window (${elapsed} ms)`);
  });

  it("leaves no lock, response or error file behind on a clean run", async () => {
    const h = await harness();
    await run(h);
    const left = (await readdir(h.cacheDir)).filter(
      (f) => f.endsWith(".lock") || f.endsWith(".resp") || f.endsWith(".err"),
    );
    assert.deepEqual(left, []);
  });
});

describe("the way pi actually invokes this script", () => {
  // pi-coding-agent 0.84.0, dist/core/resolve-config-value.js -> executeWithDefaultShell:
  //   execSync(command, { encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] })
  // reached from resolveConfigValueOrThrow -> resolveConfigValueUncached, i.e. bypassing pi's own
  // process-lifetime command cache. Three properties of that call shape are load-bearing and none
  // of them is obvious from the script alone, so each gets a regression test.
  const PI_CEILING_MS = 10_000;

  function runAsPi(h: Harness, env: Record<string, string> = {}): Promise<RunResult & { elapsedMs: number }> {
    // execSync waits for the STDOUT PIPE TO CLOSE, not merely for the process to exit. Node's
    // "close" event is that same condition, so spawning and timing to "close" reproduces exactly
    // what pi's 10 s ceiling measures — without depending on execSync's own throw shape.
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [SCRIPT], {
        env: {
          ...process.env,
          PATH: `${h.binDir}:${process.env.PATH ?? ""}`,
          PI_DBX_CACHE_DIR: h.cacheDir,
          DATABRICKS_HOST: "https://example-workspace.invalid",
          STUB_TOKEN: "dapiSTUBnotArealPatValue00000001",
          STUB_EXPIRY: isoIn(3600),
          ...env,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr, elapsedMs: Date.now() - started }));
    });
  }

  it("closes stdout as soon as it exits — an inherited pipe is a 10 s ETIMEDOUT on every refresh", async () => {
    // The regression this pins: the fetch watchdog used to be `( sleep 60; kill ) &`, which
    // inherited stdout. The script finished in ~0.5 s with a valid token and a published cache,
    // the orphaned `sleep` held the pipe for the remaining 59 s, and pi threw ETIMEDOUT at its
    // ceiling — for every single token refresh, with its stderr discarded.
    const h = await harness();
    const cold = await runAsPi(h);
    assert.equal(cold.code, 0);
    assert.equal(cold.stdout, "dapiSTUBnotArealPatValue00000001");
    assert.ok(
      cold.elapsedMs < PI_CEILING_MS / 2,
      `a cold fetch must close its stdout well inside pi's ${PI_CEILING_MS} ms ceiling, took ${cold.elapsedMs} ms`,
    );
    assert.equal(await callCount(h), 1);

    const warm = await runAsPi(h);
    assert.equal(warm.stdout, cold.stdout);
    assert.ok(warm.elapsedMs < 2_000, `a cache hit took ${warm.elapsedMs} ms`);
  });

  it("keeps both default budgets under pi's uncontrollable 10 s ceiling", async () => {
    // A fetch budget or a lock wait above 10 s cannot ever fire: pi kills the script first, with
    // the diagnostics discarded and no cache written. These two defaults are read out of the
    // script itself so that raising one without revisiting this note fails here.
    const source = await readFile(SCRIPT, "utf8");
    const fetchDefault = Number(/PI_DBX_FETCH_TIMEOUT:-(\d+)/.exec(source)?.[1]);
    const lockDefault = Number(/PI_DBX_LOCK_WAIT:-(\d+)/.exec(source)?.[1]);
    assert.ok(Number.isFinite(fetchDefault), "PI_DBX_FETCH_TIMEOUT default not found");
    assert.ok(Number.isFinite(lockDefault), "PI_DBX_LOCK_WAIT default not found");
    assert.ok(fetchDefault * 1000 < PI_CEILING_MS, `fetch budget ${fetchDefault}s >= pi's ceiling`);
    assert.ok(lockDefault * 1000 < PI_CEILING_MS, `lock wait ${lockDefault}s >= pi's ceiling`);
  });

  it("mirrors every diagnostic into the log, because pi runs this with stderr set to ignore", async () => {
    const h = await harness({ failWith: "Error: dapiDEADBEEFDEADBEEFDEADBEEF is not valid" });
    const result = await run(h);
    assert.notEqual(result.code, 0);

    const logPath = join(h.cacheDir, "dbx-token.log");
    const log = await readFile(logPath, "utf8");
    assert.match(log, /databricks auth token failed \(exit 7\)/);
    // Same redaction as stderr — the log sits next to the token cache and must never become the
    // one place a credential is written in the clear.
    assert.doesNotMatch(log, /dapiDEADBEEF/);
    assert.match(log, /<redacted-pat>/);
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
  });

  it("does not write a log when PI_DBX_LOG is blanked", async () => {
    const h = await harness({ failWith: "Error: nope" });
    await run(h, { PI_DBX_LOG: "" });
    const left = (await readdir(h.cacheDir)).filter((f) => f.endsWith(".log"));
    assert.deepEqual(left, []);
  });
});

describe("on-disk hygiene", () => {
  it("writes the cache 0600 inside a 0700 directory", async () => {
    const h = await harness();
    await run(h);
    const dirMode = (await stat(h.cacheDir)).mode & 0o777;
    assert.equal(dirMode, 0o700);
    const files = (await readdir(h.cacheDir)).filter((f) => f.endsWith(".json"));
    const fileMode = (await stat(join(h.cacheDir, files[0] as string))).mode & 0o777;
    assert.equal(fileMode, 0o600);
  });

  it("writes the fetch counter 0600 too — it sits beside the token", async () => {
    const h = await harness();
    await run(h);
    const counts = (await readdir(h.cacheDir)).filter((f) => f.endsWith(".count"));
    const mode = (await stat(join(h.cacheDir, counts[0] as string))).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("stdout is exactly the token — no newline, no banner", async () => {
    const h = await harness();
    const result = await run(h);
    assert.equal(result.stdout, "dapiSTUBnotArealPatValue00000001");
    assert.doesNotMatch(result.stdout, /\n/);
  });
});
