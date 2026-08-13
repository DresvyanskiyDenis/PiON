import assert from "node:assert/strict";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  CONFIG_DIR_NAME,
  configDir,
  ensureStateRoot,
  fallbackTmp,
  lockDir,
  repoRoot,
  scratchDir,
  stateRoot,
} from "../../extensions/lib/paths.ts";

let sandbox: string;
before(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "pi-paths-"));
});
after(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("paths", () => {
  it("configDir agrees with PI's own resolver, dot included exactly once", () => {
    assert.equal(configDir(), getAgentDir());
    assert.equal(CONFIG_DIR_NAME, ".pi");
    assert.equal(configDir().includes("..pi"), false, "the config dir name already carries its dot");
  });

  it("configDir honours PI's env override rather than a hardcoded ~/.pi", () => {
    const before = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
    try {
      assert.equal(configDir(), join(sandbox, "agent"));
    } finally {
      if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = before;
    }
  });

  it("stateRoot follows XDG_STATE_HOME when set", () => {
    const before = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(sandbox, "xdg");
    try {
      assert.equal(stateRoot(), join(sandbox, "xdg", "pi-config"));
      assert.equal(scratchDir("s-1"), join(sandbox, "xdg", "pi-config", "scratch", "s-1"));
      assert.equal(lockDir("session-digest"), join(sandbox, "xdg", "pi-config", "locks", "session-digest"));
    } finally {
      if (before === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = before;
    }
  });

  it("stateRoot defaults to ~/.local/state/pi-config", () => {
    const before = process.env.XDG_STATE_HOME;
    delete process.env.XDG_STATE_HOME;
    try {
      assert.equal(stateRoot(), join(homedir(), ".local", "state", "pi-config"));
    } finally {
      if (before !== undefined) process.env.XDG_STATE_HOME = before;
    }
  });

  it("repoRoot honours PI_CONFIG_REPO", () => {
    const before = process.env.PI_CONFIG_REPO;
    process.env.PI_CONFIG_REPO = join(sandbox, "repo");
    try {
      assert.equal(repoRoot(), join(sandbox, "repo"));
    } finally {
      if (before === undefined) delete process.env.PI_CONFIG_REPO;
      else process.env.PI_CONFIG_REPO = before;
    }
  });

  it("ensureStateRoot creates the directory 0700 and returns it", async () => {
    const before = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(sandbox, "fresh");
    try {
      const root = await ensureStateRoot(() => assert.fail("must not announce on the happy path"));
      assert.equal(root, join(sandbox, "fresh", "pi-config"));
      const { stat } = await import("node:fs/promises");
      assert.equal((await stat(root)).mode & 0o777, 0o700);
    } finally {
      if (before === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = before;
    }
  });

  it("an unwritable state root falls back to tmp and ANNOUNCES it", async () => {
    const blocker = join(sandbox, "blocker-file");
    await writeFile(blocker, "not a directory");
    const before = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = blocker;
    const lines: string[] = [];
    try {
      const root = await ensureStateRoot((l) => void lines.push(l));
      assert.equal(root, fallbackTmp());
      assert.equal(lines.length, 1, "a silent relocation is exactly what REQ-EXT-16 forbids");
      assert.match(lines[0], /is unusable/);
      assert.match(lines[0], /will not survive a reboot/);
    } finally {
      if (before === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = before;
    }
  });
});
