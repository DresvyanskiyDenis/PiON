// EXT-09 — REQ-PRV-27's token file: missing = not configured (fine), present-and-broken = loud.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { QuotaTokenError, readToken, validateToken } from "../../extensions/quota/store.ts";

let sandbox: string;
before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-quota-store-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function writeTokenFile(name: string, body: unknown, mode = 0o600): Promise<string> {
  const path = join(sandbox, name);
  await writeFile(path, JSON.stringify(body));
  await chmod(path, mode);
  return path;
}

describe("readToken", () => {
  it("a missing file is 'not configured yet', not an error", async () => {
    const result = await readToken(join(sandbox, "does-not-exist.json"));
    assert.equal(result, undefined);
  });

  it("a valid 0600 file parses all fields", async () => {
    const path = await writeTokenFile("valid.json", {
      token: "ghp_abc123",
      tier: "business",
      regime: "credits",
      createdAt: "2026-08-06",
    });
    const tok = await readToken(path);
    assert.deepEqual(tok, { token: "ghp_abc123", tier: "business", regime: "credits", createdAt: "2026-08-06" });
  });

  it("a valid 0400 (stricter than 0600) file is also accepted", async () => {
    const path = await writeTokenFile("strict.json", { token: "ghp_abc123" }, 0o400);
    const tok = await readToken(path);
    assert.equal(tok?.token, "ghp_abc123");
  });

  it("group-readable (0640) is rejected — REQ-PRV-27", async () => {
    const path = await writeTokenFile("loose.json", { token: "ghp_abc123" }, 0o640);
    await assert.rejects(readToken(path), QuotaTokenError);
  });

  it("world-readable (0644) is rejected — the exact chmod 644 the spec's acceptance test uses", async () => {
    const path = await writeTokenFile("644.json", { token: "ghp_abc123" }, 0o644);
    await assert.rejects(readToken(path), QuotaTokenError);
  });

  it("not valid JSON -> QuotaTokenError", async () => {
    const path = join(sandbox, "bad.json");
    await writeFile(path, "{not json");
    await chmod(path, 0o600);
    await assert.rejects(readToken(path), QuotaTokenError);
  });
});

describe("validateToken", () => {
  it("rejects a missing/empty token", () => {
    assert.throws(() => validateToken({}), QuotaTokenError);
    assert.throws(() => validateToken({ token: "" }), QuotaTokenError);
  });

  it("rejects a fine-grained github_pat_ token by name — the enterprise endpoint does not accept it", () => {
    assert.throws(() => validateToken({ token: "github_pat_11ABCDEF" }), /fine-grained/);
  });

  it("rejects an invalid tier", () => {
    assert.throws(() => validateToken({ token: "ghp_x", tier: "hobbyist" }), QuotaTokenError);
  });

  it("accepts every declared tier", () => {
    for (const tier of ["free", "pro", "pro+", "business", "enterprise"]) {
      assert.equal(validateToken({ token: "ghp_x", tier }).tier, tier);
    }
  });

  it("tier/regime/createdAt are optional", () => {
    const tok = validateToken({ token: "ghp_x" });
    assert.equal(tok.token, "ghp_x");
    assert.equal(tok.tier, undefined);
    assert.equal(tok.regime, undefined);
  });

  it("rejects a non-object root", () => {
    assert.throws(() => validateToken("nope"), QuotaTokenError);
    assert.throws(() => validateToken(null), QuotaTokenError);
  });
});
