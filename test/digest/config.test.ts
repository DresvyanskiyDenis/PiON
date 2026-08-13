import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  DEFAULT_DIGEST_CONFIG,
  DIGEST_VERSION,
  DigestConfigError,
  RECURSION_ENV,
  expandHome,
  loadDigestConfig,
  validateDigestConfig,
} from "../../extensions/digest/config.ts";

let sandbox: string;
before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-digest-config-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("digest config — constants", () => {
  it("stamps a concrete version and a stable recursion-guard env var name", () => {
    assert.equal(DIGEST_VERSION, 2);
    assert.equal(RECURSION_ENV, "PI_DIGEST_WORKER");
  });
});

describe("digest config — loadDigestConfig", () => {
  it("a missing file falls back to defaults — 'not configured yet' is not an error", async () => {
    const cfg = await loadDigestConfig(join(sandbox, "does-not-exist.json"));
    assert.deepEqual(cfg, DEFAULT_DIGEST_CONFIG);
  });

  it("a present, valid file overrides the defaults", async () => {
    const path = join(sandbox, "valid.json");
    await writeFile(
      path,
      JSON.stringify({
        digest: {
          enabled: false,
          minTurns: 5,
          maxTranscriptBytes: 1000,
          outputDir: "/tmp/digests",
          summarizer: { kind: "off" },
        },
      }),
    );
    const cfg = await loadDigestConfig(path);
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.minTurns, 5);
    assert.equal(cfg.maxTranscriptBytes, 1000);
    assert.equal(cfg.outputDir, "/tmp/digests");
    assert.deepEqual(cfg.summarizer, { kind: "off" });
  });

  it("a present but not-JSON file throws DigestConfigError, not a bare parse error", async () => {
    const path = join(sandbox, "bad.json");
    await writeFile(path, "{ not json");
    await assert.rejects(() => loadDigestConfig(path), DigestConfigError);
  });

  it("REQ-PRV-32: a malformed present file fails loud rather than silently downgrading to defaults", async () => {
    const path = join(sandbox, "malformed.json");
    await writeFile(path, JSON.stringify({ digest: { summarizer: { kind: "bogus" } } }));
    await assert.rejects(
      () => loadDigestConfig(path),
      (err: unknown) => {
        assert.ok(err instanceof DigestConfigError);
        assert.match(err.message, /digest\.summarizer\.kind/);
        assert.equal(err.path, path);
        return true;
      },
    );
  });

  it("an unreadable-for-other-reasons file (e.g. a directory) throws DigestConfigError with a cause", async () => {
    const dirAsFile = join(sandbox, "a-directory");
    await mkdir(dirAsFile);
    await assert.rejects(
      () => loadDigestConfig(dirAsFile),
      (err: unknown) => {
        assert.ok(err instanceof DigestConfigError);
        assert.ok(err.cause);
        return true;
      },
    );
  });
});

describe("digest config — validateDigestConfig", () => {
  it("rejects a non-object root", () => {
    assert.throws(() => validateDigestConfig(null), DigestConfigError);
    assert.throws(() => validateDigestConfig("nope"), DigestConfigError);
  });

  it("rejects a root without a digest object", () => {
    assert.throws(() => validateDigestConfig({}), /missing "digest" object/);
  });

  it("rejects wrong types for each scalar field", () => {
    assert.throws(() => validateDigestConfig({ digest: { enabled: "yes" } }), /enabled.*boolean/);
    assert.throws(() => validateDigestConfig({ digest: { minTurns: -1 } }), /minTurns/);
    assert.throws(() => validateDigestConfig({ digest: { minTurns: 1.5 } }), /minTurns/);
    assert.throws(
      () => validateDigestConfig({ digest: { maxTranscriptBytes: 0 } }),
      /maxTranscriptBytes/,
    );
    assert.throws(() => validateDigestConfig({ digest: { outputDir: "" } }), /outputDir/);
  });

  it("defaults minTurns of exactly 0 is valid (every session gets a digest)", () => {
    const cfg = validateDigestConfig({ digest: { minTurns: 0 } });
    assert.equal(cfg.minTurns, 0);
  });

  it("summarizer 'pi' requires a non-empty model (tier name) and a positive timeout", () => {
    assert.throws(
      () => validateDigestConfig({ digest: { summarizer: { kind: "pi" } } }),
      /summarizer\.model.*tier/,
    );
    assert.throws(
      () =>
        validateDigestConfig({
          digest: { summarizer: { kind: "pi", model: "cheap", timeoutMs: -1 } },
        }),
      /timeoutMs/,
    );
    const cfg = validateDigestConfig({
      digest: { summarizer: { kind: "pi", model: "cheap", timeoutMs: 5000 } },
    });
    assert.deepEqual(cfg.summarizer, { kind: "pi", model: "cheap", timeoutMs: 5000 });
  });

  it("summarizer 'command' requires a non-empty argv of non-empty strings", () => {
    assert.throws(
      () => validateDigestConfig({ digest: { summarizer: { kind: "command", argv: [] } } }),
      /argv/,
    );
    assert.throws(
      () =>
        validateDigestConfig({ digest: { summarizer: { kind: "command", argv: ["ok", ""] } } }),
      /argv/,
    );
    const cfg = validateDigestConfig({
      digest: { summarizer: { kind: "command", argv: ["cat"] } },
    });
    assert.deepEqual(cfg.summarizer, { kind: "command", argv: ["cat"], timeoutMs: 120_000 });
  });

  it("summarizer 'off' needs nothing else", () => {
    const cfg = validateDigestConfig({ digest: { summarizer: { kind: "off" } } });
    assert.deepEqual(cfg.summarizer, { kind: "off" });
  });

  it("rejects an unknown summarizer kind — never guesses", () => {
    assert.throws(
      () => validateDigestConfig({ digest: { summarizer: { kind: "claude" } } }),
      /"pi", "command" or "off"/,
    );
  });

  it("an absent summarizer field falls back to the default (pi:cheap)", () => {
    const cfg = validateDigestConfig({ digest: {} });
    assert.deepEqual(cfg.summarizer, DEFAULT_DIGEST_CONFIG.summarizer);
  });
});

describe("digest config — expandHome", () => {
  it("expands a bare '~'", () => {
    const home = process.env.HOME ?? "";
    assert.equal(expandHome("~"), home);
  });

  it("expands '~/...' ", () => {
    const home = process.env.HOME ?? "";
    assert.equal(expandHome("~/.pi/agent/digests"), `${home}/.pi/agent/digests`);
  });

  it("expands $HOME and ${HOME} inline", () => {
    const home = process.env.HOME ?? "";
    assert.equal(expandHome("$HOME/digests"), `${home}/digests`);
    assert.equal(expandHome("${HOME}/digests"), `${home}/digests`);
  });

  it("leaves an already-absolute path alone", () => {
    assert.equal(expandHome("/tmp/digests"), "/tmp/digests");
  });
});
