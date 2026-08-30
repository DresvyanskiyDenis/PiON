// EXT-07 — extensions/web/config-guard.ts
//
// Isolation: PI_CODING_AGENT_DIR points both configDir() (our own
// extensions/lib/paths.ts, which delegates to PI's getAgentDir()) and pi-web-access's own
// getWebSearchConfigPath() at the same throwaway directory, so no test touches ~/.pi/agent or the
// network. Setting the same env var for both is itself the fix for the directory-mismatch finding
// recorded in config/shell/pi-env.sh.
import { shippedConfig } from "../lib/repo-config.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("assertPinnedSearchBackend", async (t) => {
  let dir: string;
  const originalDir = process.env.PI_CODING_AGENT_DIR;

  t.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-config-ext07-guard-"));
    process.env.PI_CODING_AGENT_DIR = dir;
  });
  t.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
  });

  function write(name: string, doc: unknown): void {
    writeFileSync(join(dir, name), JSON.stringify(doc));
  }

  // Fresh module instance per PI_CODING_AGENT_DIR value: pi-web-access's utils.ts computes
  // getWebSearchConfigPath() fresh on every call (no caching), but node's ESM cache would still
  // serve the same imported functions across tests — that is fine here since the path is derived
  // from process.env at call time, not at import time. A single dynamic import is enough.
  const { assertPinnedSearchBackend } = await import("../../extensions/web/config-guard.ts");

  await t.test("both files agree on 'searxng' -> returns the pinned backend, no throw", () => {
    write("web.json", { version: 1, search: { backend: "searxng" } });
    write("web-search.json", { provider: "searxng" });
    const result = assertPinnedSearchBackend();
    assert.equal(result.backend, "searxng");
    assert.match(result.declaredPath, /web\.json$/);
    assert.match(result.liveConfigPath, /web-search\.json$/);
  });

  // EXT-07 pins how MANY backends are declared, never which one — so every backend the installer
  // can write has to pass on exactly the same terms as searxng, and drift between the two files
  // has to fail on exactly the same terms too. Table-driven so adding a backend to install.sh's
  // enum without adding it here is a visible omission rather than an untested path.
  for (const backend of ["tavily", "brave", "exa"]) {
    await t.test(`both files agree on '${backend}' -> returns the pinned backend, no throw`, () => {
      write("web.json", { version: 1, search: { backend } });
      write("web-search.json", { provider: backend });
      assert.equal(assertPinnedSearchBackend().backend, backend);
    });

    await t.test(`'${backend}' declared but web-search.json still says 'none' -> throws`, () => {
      write("web.json", { version: 1, search: { backend } });
      write("web-search.json", { provider: "none" });
      assert.throws(() => assertPinnedSearchBackend(), /pinned-backend mismatch/);
    });
  }

  await t.test("config/web.json missing -> throws naming the path", () => {
    write("web-search.json", { provider: "searxng" });
    assert.throws(() => assertPinnedSearchBackend(), /EXT-07's declared-backend file.*web\.json/s);
  });

  await t.test("config/web-search.json missing -> throws naming pi-web-access's config", () => {
    write("web.json", { version: 1, search: { backend: "searxng" } });
    assert.throws(() => assertPinnedSearchBackend(), /pi-web-access's own config.*web-search\.json/s);
  });

  await t.test('provider: "auto" -> throws, refuses multi-provider auto-detection', () => {
    write("web.json", { version: 1, search: { backend: "auto" } });
    write("web-search.json", { provider: "auto" });
    assert.throws(() => assertPinnedSearchBackend(), /"auto"\/"all"/);
  });

  await t.test("provider as an array -> throws, refuses concurrent fan-out", () => {
    write("web.json", { version: 1, search: { backend: "searxng" } });
    write("web-search.json", { provider: ["searxng", "brave"] });
    assert.throws(() => assertPinnedSearchBackend(), /concurrent multi-provider fan-out/);
  });

  await t.test("web.json and web-search.json disagree -> throws naming both values", () => {
    write("web.json", { version: 1, search: { backend: "searxng" } });
    write("web-search.json", { provider: "brave" });
    assert.throws(() => assertPinnedSearchBackend(), /pinned-backend mismatch/);
  });

  await t.test("web-search.json missing 'provider' entirely -> throws", () => {
    write("web.json", { version: 1, search: { backend: "searxng" } });
    write("web-search.json", {});
    assert.throws(() => assertPinnedSearchBackend(), /no "provider" set/);
  });

  await t.test("web.json missing 'search.backend' -> throws", () => {
    write("web.json", { version: 1 });
    write("web-search.json", { provider: "searxng" });
    assert.throws(() => assertPinnedSearchBackend(), /no non-empty "search\.backend"/);
  });
});

test("assertFetchToolAliasedToWebFetch", async (t) => {
  let dir: string;
  const originalDir = process.env.PI_CODING_AGENT_DIR;

  t.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-config-ext07-alias-"));
    process.env.PI_CODING_AGENT_DIR = dir;
  });
  t.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
  });

  function write(name: string, doc: unknown): void {
    writeFileSync(join(dir, name), JSON.stringify(doc));
  }

  const { assertFetchToolAliasedToWebFetch } = await import("../../extensions/web/config-guard.ts");

  await t.test('toolNames.fetchContent === "web_fetch" -> returns it, no throw', () => {
    write("web-search.json", { provider: "searxng", toolNames: { fetchContent: "web_fetch" } });
    const result = assertFetchToolAliasedToWebFetch();
    assert.equal(result.name, "web_fetch");
    assert.match(result.path, /web-search\.json$/);
  });

  await t.test("toolNames.fetchContent absent -> throws, names the missing override", () => {
    write("web-search.json", { provider: "searxng" });
    assert.throws(() => assertFetchToolAliasedToWebFetch(), /toolNames.*fetchContent.*web_fetch/s);
  });

  await t.test('toolNames.fetchContent left as the package default "fetch_content" -> throws', () => {
    write("web-search.json", { provider: "searxng", toolNames: { fetchContent: "fetch_content" } });
    assert.throws(() => assertFetchToolAliasedToWebFetch(), /Currently: "fetch_content"/);
  });

  await t.test("toolNames not an object -> throws rather than crashing", () => {
    write("web-search.json", { provider: "searxng", toolNames: "web_fetch" });
    assert.throws(() => assertFetchToolAliasedToWebFetch(), /toolNames.*fetchContent.*web_fetch/s);
  });
});

test("checkSearchWorkflowPinned", async (t) => {
  let dir: string;
  const originalDir = process.env.PI_CODING_AGENT_DIR;

  t.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pion-ext07-workflow-"));
    process.env.PI_CODING_AGENT_DIR = dir;
  });
  t.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
  });

  const { checkSearchWorkflowPinned } = await import("../../extensions/web/config-guard.ts");

  await t.test('workflow: "none" -> pinned, no problem', () => {
    writeFileSync(join(dir, "web-search.json"), JSON.stringify({ provider: "searxng", workflow: "none" }));
    assert.equal(checkSearchWorkflowPinned(), undefined);
  });

  await t.test('workflow: "summary-review" -> also pinned: the check is that a value was chosen, not which', () => {
    writeFileSync(join(dir, "web-search.json"), JSON.stringify({ provider: "searxng", workflow: "summary-review" }));
    assert.equal(checkSearchWorkflowPinned(), undefined);
  });

  await t.test("the key missing -> reported, because that is what a stale generated file looks like", () => {
    writeFileSync(join(dir, "web-search.json"), JSON.stringify({ provider: "searxng" }));
    const problem = checkSearchWorkflowPinned();
    assert.match(problem ?? "", /no "workflow" pinned/);
    assert.match(problem ?? "", /summary-review/);
  });

  await t.test("a non-string value is reported rather than trusted", () => {
    writeFileSync(join(dir, "web-search.json"), JSON.stringify({ provider: "searxng", workflow: false }));
    assert.match(checkSearchWorkflowPinned() ?? "", /Currently: false/);
  });

  await t.test("a missing config file is silent here — assertPinnedSearchBackend already refuses over it", () => {
    assert.equal(checkSearchWorkflowPinned(), undefined);
  });
});

test("the tracked web-search template pins the search workflow", async () => {
  // The durability half, asserted against the TEMPLATE rather than the generated file. `/curator
  // on|off` writes the same key into the generated config at runtime, and a fresh machine
  // regenerates that file from this template, so the template is the only copy that survives one.
  // A generated file on somebody's machine is theirs, and an unpinned key there is what
  // `checkSearchWorkflowPinned()` reports at session_start; it is not this test's business.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const template = fileURLToPath(new URL("../../config/web-search.default.json", import.meta.url));
  const doc = JSON.parse(readFileSync(template, "utf8")) as { workflow?: unknown };
  assert.equal(typeof doc.workflow, "string");
  assert.ok((doc.workflow as string).length > 0, 'config/web-search.default.json must pin "workflow"');
});

test("this repository's own web.json and web-search.json agree, as installed", async () => {
  // Reads the pair the checkout actually carries — the generated `config/web.json` on an installed
  // machine, the tracked `config/web.default.json` template on a clean clone (both are git-ignored /
  // template halves of the same file, see test/lib/repo-config.ts) — and proves they still satisfy
  // the two session_start invariants once staged where PI_CODING_AGENT_DIR points.
  //
  // The backend value itself is NOT pinned here. The shipped template pins "none" because no public
  // default can assume a SearXNG instance exists; an installed machine pins whatever the operator
  // chose. What must hold in both cases is that the two files name the SAME backend — a drift
  // between them is the failure this guard exists for — and that the fetch-tool rename survives.
  const dir = mkdtempSync(join(tmpdir(), "pi-config-ext07-installed-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    const { readFileSync, writeFileSync: write } = await import("node:fs");
    write(join(dir, "web.json"), readFileSync(shippedConfig("web"), "utf8"));
    write(join(dir, "web-search.json"), readFileSync(shippedConfig("web-search"), "utf8"));

    const { assertPinnedSearchBackend, assertFetchToolAliasedToWebFetch } = await import(
      "../../extensions/web/config-guard.ts"
    );
    const declared = JSON.parse(readFileSync(shippedConfig("web"), "utf8")) as { search?: { backend?: string } };
    const result = assertPinnedSearchBackend();
    assert.equal(result.backend, declared.search?.backend, "both files must name the same backend");
    const alias = assertFetchToolAliasedToWebFetch();
    assert.equal(alias.name, "web_fetch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
  }
});
