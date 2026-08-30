// `prompt_cache_key` through a gateway: the flag the interview writes, and the premise it rests on.
//
// WHAT THE DEFECT IS
//
// A gateway in front of an Azure or OpenAI-compatible backend may partition its prompt cache by the
// client-sent `prompt_cache_key`. PI never sends one through a proxy. `pi-ai`'s openai-completions
// path emits the field under exactly two conditions — the model's `baseUrl` contains
// `api.openai.com`, or the turn asked for `cacheRetention: "long"` **and** the provider declares
// `supportsLongCacheRetention` — and the second condition also sets `prompt_cache_retention: "24h"`,
// which is a different request with a different failure mode. Behind a proxy the first can never
// fire and the second cannot be taken alone, so every session shares one cache partition and evicts
// the others. Nothing errors; the cache simply never hits.
//
// WHAT IS PINNED HERE, IN TWO PARTS
//
// 1. THE FRAGMENT. `litellm.json` asks the deployment question and writes `supportsPromptCacheKey`
//    only when the answer is yes. The off branch must resolve to `null` — README §3 rule 3, which
//    DELETES the key — and not to a literal `false`: a stock runtime ignores the key either way, so
//    a written `false` would be a line in `config/models.json` that nothing reads and that reads as
//    a knob somebody turned off. Absent is the only honest spelling of "not asked for".
//
// 2. THE PREMISE, IN EVERY INSTALLED COPY OF pi-ai. The flag is not part of pi-ai 0.84.0; it exists
//    only in a patched runtime (docs/configuration/litellm.md). Two things can quietly falsify the
//    documentation: upstream could add the gate itself, at which point the patch and half that page
//    should be deleted — or a patch could be applied to ONE copy of pi-ai and not the other. npm
//    leaves a second copy under `@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai`,
//    and a patch named for the package alone lands on the top-level copy while the nested one is
//    what the agent loads. So this file walks `node_modules` for EVERY copy and holds them all to
//    the same statement, rather than checking the first one it can name.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FRAGMENT = join(REPO, "config/providers/litellm.json");
const NODE_MODULES = join(REPO, "node_modules");

/** The compat key this repository asks about, and that a stock `pi-ai` does not read. */
const FLAG = "supportsPromptCacheKey";

/** A value a fragment defers to an answer: the string is EXACTLY one `{{token}}`. */
const WHOLE_TOKEN = /^\{\{([A-Za-z0-9_]+)\}\}$/;

interface Fragment {
  prompts?: Array<{ id: string; type: string; default?: unknown; required?: boolean }>;
  derived?: Array<{ id: string; from: string; map: Record<string, unknown> }>;
  provider?: { compat?: Record<string, unknown> };
  notes?: string[];
  verify?: Array<{ label: string; command: string }>;
}

const fragment = JSON.parse(readFileSync(FRAGMENT, "utf8")) as Fragment;

/**
 * Every installed copy of `@earendil-works/pi-ai`, top-level and nested. The walk is bounded to the
 * shape npm actually produces — `node_modules/<scope>/<pkg>/node_modules/…` — because the point is
 * to find duplicates of one package, not to enumerate the tree.
 */
function piAiCopies(root: string, depth = 3): string[] {
  if (depth === 0 || !existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = join(root, entry.name);
    if (entry.name.startsWith("@")) {
      found.push(...piAiCopies(dir, depth));
      continue;
    }
    if (existsSync(join(dir, "package.json"))) {
      if (dir.endsWith(join("@earendil-works", "pi-ai"))) found.push(dir);
      found.push(...piAiCopies(join(dir, "node_modules"), depth - 1));
    }
  }
  return found;
}

describe("litellm fragment — prompt_cache_key is asked, and off means absent", () => {
  const prompt = (fragment.prompts ?? []).find((p) => p.id === "promptCacheKey");

  it("the deployment fact is a boolean question that defaults to off", () => {
    assert.ok(
      prompt,
      "config/providers/litellm.json no longer asks `promptCacheKey`. Whether a gateway partitions " +
        "its prompt cache by that key is a fact about somebody's deployment, so it is asked, not " +
        "written down.",
    );
    assert.equal(prompt?.type, "boolean");
    assert.equal(
      String(prompt?.default),
      "false",
      "the default has to be off: the flag is inert on an unpatched runtime, so the answer nobody " +
        "gave must be the one that changes nothing.",
    );
  });

  it("the compat key is the answer, never a literal", () => {
    const declared = fragment.provider?.compat?.[FLAG];
    assert.ok(
      typeof declared === "string" && WHOLE_TOKEN.test(declared),
      `compat.${FLAG} is ${JSON.stringify(declared)}. It has to be a lone {{token}}: a literal ` +
        `true would turn a gateway's behaviour into a claim this file cannot make, and a literal ` +
        `false would write a key that nothing reads.`,
    );
    const derived = (fragment.derived ?? []).find((d) => d.id === WHOLE_TOKEN.exec(declared as string)?.[1]);
    assert.ok(derived, `compat.${FLAG} defers to a value that is not a \`derived\` entry`);
    assert.equal(derived?.from, "promptCacheKey");
    assert.equal(
      derived?.map.true,
      true,
      "the yes branch is the literal boolean true; a string \"true\" would reach models.json quoted",
    );
    for (const key of ["false", ""]) {
      assert.strictEqual(
        derived?.map[key],
        null,
        `derived "${derived?.id}" maps ${JSON.stringify(key)} to ${JSON.stringify(derived?.map[key])}. ` +
          `Both the explicit no and the answers file written before this prompt existed have to ` +
          `resolve to null, which README §3 rule 3 deletes: not asking for a cache key is the ` +
          `absence of the key, not a false somebody wrote down.`,
      );
    }
  });

  it("a note says the flag is inert on the shipped runtime, and names where the recipe is", () => {
    // The one thing an operator can get wrong here is invisible: answer yes, see no error, and
    // believe the cache is partitioned. The note is the only place that is said before the bill.
    const notes = (fragment.notes ?? []).filter((n) => n.includes(FLAG));
    assert.ok(notes.length > 0, `no note in litellm.json mentions ${FLAG}`);
    assert.ok(
      notes.some((n) => /docs\/configuration\/litellm\.md/.test(n)),
      `the ${FLAG} note has to name docs/configuration/litellm.md, which is where patching the ` +
        `runtime is written down`,
    );
  });

  it("a verify one-liner turns the flag from believed into measured", () => {
    assert.ok(
      (fragment.verify ?? []).some((v) => v.command.includes(FLAG)),
      "nothing in verify[] checks whether the installed runtime reads the flag, so the silent " +
        "no-op stays silent",
    );
  });
});

describe("installed pi-ai — the premise the fragment and the docs rest on", () => {
  const copies = piAiCopies(NODE_MODULES);

  it("there is at least one copy to check, or this file is testing nothing", () => {
    assert.ok(
      copies.length > 0,
      `no @earendil-works/pi-ai under ${NODE_MODULES}. Run npm install before npm test.`,
    );
  });

  for (const copy of copies) {
    const rel = copy.slice(REPO.length);
    const source = join(copy, "dist/api/openai-completions.js");
    const version = JSON.parse(readFileSync(join(copy, "package.json"), "utf8")).version as string;

    it(`${rel} (${version}): sends prompt_cache_key only for api.openai.com or long retention`, () => {
      const text = readFileSync(source, "utf8");
      const call = text.slice(text.indexOf("prompt_cache_key"), text.indexOf("prompt_cache_key") + 400);
      assert.ok(text.includes("prompt_cache_key"), `${rel} no longer mentions prompt_cache_key at all`);
      assert.match(
        call,
        /api\.openai\.com/,
        `${rel} no longer gates prompt_cache_key on the base URL. If upstream widened it, the ` +
          `interview question and half of docs/configuration/litellm.md are obsolete.`,
      );
      assert.match(
        call,
        /supportsLongCacheRetention/,
        `${rel} no longer ties the second branch to supportsLongCacheRetention. The docs claim the ` +
          `only other way to get a cache key is to also ask for 24h retention; check that first.`,
      );
    });

    it(`${rel} (${version}): does not read ${FLAG} — the flag is a patch, not a feature`, () => {
      // Fails in both directions on purpose. Upstream adopting the flag is good news that must be
      // read, not absorbed: the patch would then be redundant and the page describing it wrong. A
      // patched tree fails here too, which is the point — a patch that reaches one copy of pi-ai
      // and not the other is the defect this test exists to make loud, and a green suite on a
      // half-patched tree would be worse than no test.
      assert.ok(
        !readFileSync(source, "utf8").includes(FLAG),
        `${rel} reads ${FLAG}. Either upstream added it (drop the patch and the section in ` +
          `docs/configuration/litellm.md), or this tree is patched (this repository ships no ` +
          `patch, and a patch applied to some copies and not others is what silently does nothing).`,
      );
    });
  }
});
