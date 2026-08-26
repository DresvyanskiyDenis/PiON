import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  discoverDeclaredAgents,
  discoverDeclaredSkills,
  readDeclaredServers,
  readDeclaredTools,
  readPackagesLock,
  readRoutingTiers,
  resolveInstalledPackageVersion,
} from "../../extensions/doctor/declared.ts";

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-doctor-declared-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("discoverDeclaredSkills", () => {
  it("returns [] for a clone with no skill roots at all", () => {
    assert.deepEqual(discoverDeclaredSkills(join(root, "empty")), []);
  });

  it("finds a skill dir by the presence of SKILL.md under the one root", async () => {
    const d = join(root, "skills-case");
    await mkdir(join(d, "skills", "changelog"), { recursive: true });
    await writeFile(join(d, "skills", "changelog", "SKILL.md"), "# changelog\n");
    await mkdir(join(d, "skills", "csv-import"), { recursive: true });
    await writeFile(join(d, "skills", "csv-import", "SKILL.md"), "# csv\n");
    // a stray directory with no SKILL.md must not count as a skill
    await mkdir(join(d, "skills", "not-a-skill"), { recursive: true });
    await writeFile(join(d, "skills", "not-a-skill", "notes.txt"), "x");

    assert.deepEqual(discoverDeclaredSkills(d).toSorted(), ["changelog", "csv-import"]);
  });
});

describe("discoverDeclaredAgents", () => {
  it("reports rootExists=false when agents/ is absent (wave-1 state)", () => {
    const r = discoverDeclaredAgents(join(root, "no-agents"));
    assert.equal(r.rootExists, false);
    assert.deepEqual(r.ids, []);
  });

  it("reports rootExists=true and lists .md basenames when agents/ is present", async () => {
    const d = join(root, "with-agents");
    await mkdir(join(d, "agents"), { recursive: true });
    await writeFile(join(d, "agents", "researcher.md"), "---\n---\n");
    await writeFile(join(d, "agents", "debugger.md"), "---\n---\n");
    await writeFile(join(d, "agents", "README.md"), "not an agent, but still a .md file");

    const r = discoverDeclaredAgents(d);
    assert.equal(r.rootExists, true);
    assert.deepEqual(r.ids.toSorted(), ["README", "debugger", "researcher"]);
  });
});

describe("readDeclaredServers", () => {
  it("returns [] when config/mcp.json is absent", () => {
    assert.deepEqual(readDeclaredServers(join(root, "no-mcp")), []);
  });

  it("returns every declared server key regardless of disabled", async () => {
    const d = join(root, "mcp-case");
    await mkdir(join(d, "config"), { recursive: true });
    await writeFile(
      join(d, "config", "mcp.json"),
      JSON.stringify({ mcpServers: { playwright: { disabled: false }, context7: { disabled: true } } }),
    );
    assert.deepEqual(readDeclaredServers(d).toSorted(), ["context7", "playwright"]);
  });

  it("throws a named error on corrupt JSON rather than silently returning []", async () => {
    const d = join(root, "mcp-corrupt");
    await mkdir(join(d, "config"), { recursive: true });
    await writeFile(join(d, "config", "mcp.json"), "{not json");
    assert.throws(() => readDeclaredServers(d), /not valid JSON/);
  });
});

describe("readRoutingTiers", () => {
  it("parses tier, model, optional and an (absent-today) fallback field", async () => {
    const d = join(root, "routing-case");
    await mkdir(join(d, "config"), { recursive: true });
    await writeFile(
      join(d, "config", "routing.json"),
      JSON.stringify({
        tiers: {
          strong: { model: "github-copilot/claude-opus-5" },
          local: { model: "local/unsloth/Qwen3.6-35B-A3B-MTP-GGUF", optional: true },
        },
      }),
    );
    const tiers = readRoutingTiers(d);
    const strong = tiers.find((t) => t.tier === "strong");
    const local = tiers.find((t) => t.tier === "local");
    assert.equal(strong?.modelRef, "github-copilot/claude-opus-5");
    assert.equal(strong?.optional, false);
    assert.equal(local?.modelRef, "local/unsloth/Qwen3.6-35B-A3B-MTP-GGUF");
    assert.equal(local?.optional, true);
  });
});

describe("readPackagesLock + resolveInstalledPackageVersion", () => {
  it("reports an installed version when node_modules/<name>/package.json exists", async () => {
    const d = join(root, "pkg-case");
    await mkdir(join(d, "config"), { recursive: true });
    await writeFile(
      join(d, "config", "packages.lock.json"),
      JSON.stringify({ packages: [{ name: "pi-subagents", version: "0.41.0", vendor: false, status: "adopted" }] }),
    );
    await mkdir(join(d, "node_modules", "pi-subagents"), { recursive: true });
    await writeFile(join(d, "node_modules", "pi-subagents", "package.json"), JSON.stringify({ version: "0.41.0" }));

    const [entry] = readPackagesLock(d);
    assert.equal(entry?.name, "pi-subagents");
    assert.equal(resolveInstalledPackageVersion(d, "pi-subagents"), "0.41.0");
  });

  it("returns undefined for a declared package that is not installed (R-13's absent case)", async () => {
    const d = join(root, "pkg-absent");
    await mkdir(join(d, "config"), { recursive: true });
    await writeFile(
      join(d, "config", "packages.lock.json"),
      JSON.stringify({ packages: [{ name: "@narumitw/pi-lsp", version: "1.0.0", vendor: false, status: "adopted" }] }),
    );
    assert.equal(resolveInstalledPackageVersion(d, "@narumitw/pi-lsp"), undefined);
  });

  it("resolves a scoped package name the same way node_modules lays it out", async () => {
    const d = join(root, "pkg-scoped");
    await mkdir(join(d, "node_modules", "@juicesharp", "rpiv-todo"), { recursive: true });
    await writeFile(
      join(d, "node_modules", "@juicesharp", "rpiv-todo", "package.json"),
      JSON.stringify({ version: "2.4.0" }),
    );
    assert.equal(resolveInstalledPackageVersion(d, "@juicesharp/rpiv-todo"), "2.4.0");
  });
});

describe("readDeclaredTools", () => {
  it("returns [] when config/tools.declared.json is absent", () => {
    assert.deepEqual(readDeclaredTools(join(root, "no-tools")), []);
  });

  it("reads the real repo's config/tools.declared.json", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    const tools = readDeclaredTools(repoRoot);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("expand_result"), "big-results' custom tool should be declared");
    assert.ok(names.includes("job"), "jobs' custom tool should be declared");
  });
});
