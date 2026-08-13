// W3-LSP — the LSP configuration this repository ships for `@narumitw/pi-lsp`.
//
// This file used to assert on a build-bookkeeping record that described a config fragment which had
// not been written yet ("the settingsPatch this item hands to the integration phase"). The fragment
// has since become a real, shipped file — `config/pi-lsp.json`, linked into the agent dir by
// scripts/install.sh — and the bookkeeping record is gone, so the assertions are made against the
// artifact instead.
//
// The package's own loader is deliberately NOT invoked: `@narumitw/pi-lsp` ships TypeScript sources
// only, and `node --test` refuses to strip types under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — PI transpiles them itself at load time. So the
// assertions below encode the shape that loader requires (`adapters.ts`'s normalizeConfig: a wrapper
// object keyed `servers`, each entry an argv array plus a list of extensions) and are checked against
// the file this repository actually ships.
//
// Read-only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const LSP_CONFIG = path.join(REPO, "config", "pi-lsp.json");
const PACKAGE_JSON = path.join(REPO, "package.json");
const SETTINGS_TEMPLATE = path.join(REPO, "config", "settings.default.json");

interface LspServerEntry {
  command?: unknown;
  extensions?: unknown;
}

/** `config/pi-lsp.json` — what scripts/install.sh links to `~/.pi/agent/pi-lsp.json`. */
function shippedLspConfig(): { servers: Record<string, LspServerEntry> } {
  return JSON.parse(readFileSync(LSP_CONFIG, "utf8"));
}

function servers(): Array<[string, { command: string[]; extensions: string[] }]> {
  const config = shippedLspConfig();
  assert.ok(
    config.servers && typeof config.servers === "object" && !Array.isArray(config.servers),
    "the file must use the wrapper shape { \"servers\": { \"<name>\": … } } — the loader rejects anything else",
  );
  return Object.entries(config.servers) as Array<[string, { command: string[]; extensions: string[] }]>;
}

test("package.json pins @narumitw/pi-lsp at an exact, non-floating version", () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const pin = pkg.dependencies?.["@narumitw/pi-lsp"] ?? pkg.devDependencies?.["@narumitw/pi-lsp"];
  assert.ok(pin, "@narumitw/pi-lsp must be a declared dependency");
  // exact semver, no range operators (^, ~, x, *, >, <, ||)
  assert.match(pin!, /^\d+\.\d+\.\d+$/, `pin must be exact semver, got "${pin}"`);
});

test("the settings template loads the package from the pinned checkout, not from a floating resolve", () => {
  const settings = JSON.parse(readFileSync(SETTINGS_TEMPLATE, "utf8")) as { packages?: string[] };
  assert.ok(
    (settings.packages ?? []).some((entry) => entry.endsWith("@narumitw/pi-lsp")),
    `config/settings.default.json's "packages" must load @narumitw/pi-lsp; declared: ${JSON.stringify(settings.packages ?? [])}`,
  );
});

test("declares typescript and python, each spawning a stdio language server", () => {
  const byName = new Map(servers());
  assert.deepEqual([...byName.keys()].sort(), ["python", "typescript"]);

  assert.deepEqual(byName.get("typescript")!.command, ["typescript-language-server", "--stdio"]);
  assert.deepEqual(byName.get("typescript")!.extensions, [".ts", ".tsx"]);

  // `uv run` rather than a bare `pyright-langserver`: the server lives in the project's own
  // environment, which is where a Python project's type stubs are.
  assert.deepEqual(byName.get("python")!.command, ["uv", "run", "pyright-langserver", "--stdio"]);
  assert.deepEqual(byName.get("python")!.extensions, [".py"]);
});

test("every server is an argv ARRAY, not a shell string — the loader spawns it without a shell", () => {
  for (const [name, server] of servers()) {
    assert.ok(Array.isArray(server.command) && server.command.length > 0, `${name}.command must be a non-empty array`);
    for (const word of server.command) {
      assert.equal(typeof word, "string", `${name}.command must contain only strings`);
    }
  }
});

test("no server command is a path — every one resolves on PATH, so a missing binary degrades to a warning rather than a crash", () => {
  for (const [name, server] of servers()) {
    const binary = server.command[0]!;
    assert.ok(
      !binary.startsWith("./") && !binary.startsWith("../") && !path.isAbsolute(binary),
      `${name}: "${binary}" should be a PATH-resolved binary name`,
    );
  }
});

test("every declared extension is a dotted suffix — the loader matches on it verbatim", () => {
  for (const [name, server] of servers()) {
    assert.ok(Array.isArray(server.extensions) && server.extensions.length > 0, `${name} must claim at least one extension`);
    for (const extension of server.extensions) {
      assert.match(extension, /^\.[a-z0-9]+$/i, `${name}: "${extension}" is not a dotted suffix`);
    }
  }
});
