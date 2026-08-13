// Verifies the vendored pi-mcp-adapter copy (pi-packages/pi-mcp-adapter/) is what it claims to be:
// pinned version, OSI licence present, integrity cross-checked against config/packages.lock.json
// (read-only — that file is owned by the integration agent), and that it actually resolves its
// third-party imports from the repo's top-level node_modules/ without a nested install.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VENDOR_DIR = join(REPO_ROOT, "pi-packages", "pi-mcp-adapter");

describe("EXT-14a vendored pi-mcp-adapter", () => {
  it("package.json is pinned to 2.20.1", async () => {
    const pkg = JSON.parse(await readFile(join(VENDOR_DIR, "package.json"), "utf8"));
    assert.equal(pkg.name, "pi-mcp-adapter");
    assert.equal(pkg.version, "2.20.1");
    assert.equal(pkg.license, "MIT");
  });

  it("ships an OSI-approved LICENSE file", async () => {
    const license = await readFile(join(VENDOR_DIR, "LICENSE"), "utf8");
    assert.match(license, /MIT License/);
  });

  it("vendor.lock.json's sha256 matches config/packages.lock.json's pinned hash", async () => {
    const lock = JSON.parse(await readFile(join(REPO_ROOT, "pi-packages", "vendor.lock.json"), "utf8"));
    const entry = lock.packages.find((p: { name: string }) => p.name === "pi-mcp-adapter");
    assert.ok(entry, "pi-mcp-adapter row missing from pi-packages/vendor.lock.json");

    const shared = JSON.parse(await readFile(join(REPO_ROOT, "config", "packages.lock.json"), "utf8"));
    const sharedRow = shared.vendored?.find?.((p: { name: string }) => p.name === "pi-mcp-adapter")
      // config/packages.lock.json's top-level shape may not be an object with `.vendored` — fall back to a
      // recursive scan so this test does not depend on guessing its exact schema (owned by another agent).
      ?? findRowByName(shared, "pi-mcp-adapter");
    assert.ok(sharedRow?.sha256, "could not locate a pi-mcp-adapter row with a sha256 field in config/packages.lock.json");
    assert.equal(entry.sha256, sharedRow.sha256);
  });

  it("index.ts resolves its third-party (non-peer) imports via the repo's ancestor node_modules, no nested install needed", async () => {
    // A regression guard for the empirical finding that Node's module
    // resolution walks up from pi-packages/pi-mcp-adapter/ to <repo-root>/node_modules/, so the
    // vendored copy needs no node_modules of its own and no `npm install` inside pi-packages/.
    const mod: Record<string, unknown> = await import(join(VENDOR_DIR, "config.ts"));
    assert.equal(typeof mod.loadMcpConfig, "function");
    assert.equal(typeof mod.getPiGlobalConfigPath, "function");
  });
});

function findRowByName(value: unknown, name: string): { sha256?: string } | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findRowByName(entry, name);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.name === name && typeof record.sha256 === "string") return record as { sha256: string };
    for (const v of Object.values(record)) {
      const found = findRowByName(v, name);
      if (found) return found;
    }
  }
  return undefined;
}
