// example.ts — a benign stand-in for a vendored package module, not a real one. It exists so
// PC-21 has a tree to hash in the clean fixture: the rule is a no-op when `pi-packages/` is
// absent, so without this file (and the recorded pi-packages/vendor-files.lock.json next to it)
// the fixture would prove only that PC-21 stays quiet, never that it agrees with a real manifest.
// Typed inline, importing nothing, for the same reason extensions/example.ts is — pi-check must
// run on a machine with neither PI nor this repo's node_modules installed.
export const vendoredMarker = "example-vendored-module";
export function greet(name: string): string {
  return `hello, ${name}`;
}
