// EXT-09 — config/quota.json loading/validation, mirroring test/digest/config.test.ts's shape.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DEFAULT_QUOTA_CONFIG,
  expandHome,
  loadQuotaConfig,
  QuotaConfigError,
  validateQuotaConfig,
} from "../../extensions/quota/config.ts";

let sandbox: string;
before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-quota-config-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("loadQuotaConfig", () => {
  it("a missing file falls back to defaults", async () => {
    const cfg = await loadQuotaConfig(join(sandbox, "does-not-exist.json"));
    assert.deepEqual(cfg, DEFAULT_QUOTA_CONFIG);
  });

  it("a present, valid file overrides the defaults", async () => {
    const path = join(sandbox, "valid.json");
    await writeFile(
      path,
      JSON.stringify({
        quota: {
          enabled: false,
          ttlMs: 60000,
          timeoutMs: 5000,
          tokenFile: "/tmp/quota-token.json",
          preflight: { enabled: false, thresholdPct: 20 },
        },
      }),
    );
    const cfg = await loadQuotaConfig(path);
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.ttlMs, 60000);
    assert.equal(cfg.timeoutMs, 5000);
    assert.equal(cfg.tokenFile, "/tmp/quota-token.json");
    assert.deepEqual(cfg.preflight, { enabled: false, thresholdPct: 20 });
  });

  it("a present but not-JSON file throws QuotaConfigError, not a bare parse error", async () => {
    const path = join(sandbox, "bad.json");
    await writeFile(path, "{not json");
    await assert.rejects(loadQuotaConfig(path), QuotaConfigError);
  });

  it("~ in tokenFile is expanded", async () => {
    const path = join(sandbox, "tilde.json");
    await writeFile(path, JSON.stringify({ quota: { tokenFile: "~/.config/pi/copilot-quota-token.json" } }));
    const cfg = await loadQuotaConfig(path);
    assert.equal(cfg.tokenFile, `${process.env.HOME}/.config/pi/copilot-quota-token.json`);
  });
});

describe("validateQuotaConfig", () => {
  it("rejects a non-object root", () => {
    assert.throws(() => validateQuotaConfig("nope"), QuotaConfigError);
  });
  it("rejects a missing quota object", () => {
    assert.throws(() => validateQuotaConfig({}), QuotaConfigError);
  });
  it("rejects a non-boolean enabled", () => {
    assert.throws(() => validateQuotaConfig({ quota: { enabled: "yes" } }), QuotaConfigError);
  });
  it("rejects a non-positive ttlMs", () => {
    assert.throws(() => validateQuotaConfig({ quota: { ttlMs: 0 } }), QuotaConfigError);
    assert.throws(() => validateQuotaConfig({ quota: { ttlMs: -5 } }), QuotaConfigError);
  });
  it("rejects an out-of-range preflight.thresholdPct", () => {
    assert.throws(() => validateQuotaConfig({ quota: { preflight: { thresholdPct: 150 } } }), QuotaConfigError);
    assert.throws(() => validateQuotaConfig({ quota: { preflight: { thresholdPct: -1 } } }), QuotaConfigError);
  });
  it("accepts a boundary thresholdPct of 0 and 100", () => {
    assert.equal(validateQuotaConfig({ quota: { preflight: { thresholdPct: 0 } } }).preflight.thresholdPct, 0);
    assert.equal(validateQuotaConfig({ quota: { preflight: { thresholdPct: 100 } } }).preflight.thresholdPct, 100);
  });
  it("an absent preflight object falls back to the default", () => {
    assert.deepEqual(validateQuotaConfig({ quota: {} }).preflight, DEFAULT_QUOTA_CONFIG.preflight);
  });
});

describe("expandHome", () => {
  it("expands a bare ~", () => {
    assert.equal(expandHome("~"), process.env.HOME);
  });
  it("expands ~/ prefix", () => {
    assert.equal(expandHome("~/foo/bar"), `${process.env.HOME}/foo/bar`);
  });
  it("expands $HOME and ${HOME}", () => {
    assert.equal(expandHome("$HOME/x"), `${process.env.HOME}/x`);
    assert.equal(expandHome("${HOME}/x"), `${process.env.HOME}/x`);
  });
  it("leaves an absolute path untouched", () => {
    assert.equal(expandHome("/tmp/foo.json"), "/tmp/foo.json");
  });
});
