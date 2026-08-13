/**
 * Path reconciliation shim, not a second registry.
 *
 * An earlier revision placed the load registry at `extensions/manifest.ts` and had
 * `index.ts` and `doctor.ts` import `./manifest`. The authoritative revision
 * places it in `extensions/lib/` as an `EXT-01` module, "built once,
 * here, not three times".
 *
 * Both import paths must therefore resolve to the SAME module instance: the registry is
 * module-level state, and two copies would mean `index.ts` recording loads into one while
 * `/doctor` and the deadman read the other, reporting every module as absent.
 *
 * This file must stay a re-export. If it ever grows a body, delete the body, not this note.
 */
export * from "./lib/manifest.ts";
