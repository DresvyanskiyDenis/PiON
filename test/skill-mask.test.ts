import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { id, register } from "../extensions/skill-mask.ts";

/**
 * `skill-mask` is a registered no-op since the skill buckets collapsed into one `skills/` root.
 * It used to contribute two further roots through `resources_discover`, which was the only way PI
 * could see them — and precisely the problem: a contributed root is appended after every
 * settings-declared one and loses every name collision. The roots are now declared once in
 * `config/settings.json`, so there is nothing left to contribute.
 *
 * That leaves exactly two properties worth asserting, and this file asserts both: the module
 * registers NO handler (a leftover one would silently re-add roots nobody declared), and it still
 * exports its `id` (four unrelated consumers name it — `extensions/index.ts`'s registration table,
 * `extensions/lib/manifest.ts`, `extensions/trust.ts`'s deadman list, and `/doctor`'s load
 * registry — so the id disappearing is a real breakage, not a tidy-up).
 */
describe("skill-mask", () => {
  it("keeps its id — four consumers name it, so it is not free to change", () => {
    assert.equal(id, "skill-mask");
  });

  it("registers no handler at all: the roots are declared in settings, not contributed at runtime", () => {
    const registered: string[] = [];
    const pi = {
      on: (event: string) => {
        registered.push(event);
      },
    } as unknown as ExtensionAPI;

    register(pi);
    assert.deepEqual(registered, [], "a contributed skill root loses every name collision — see the module docstring");
  });
});
