// example.ts — a benign test-fixture extension, not a real module. Typed with a minimal
// inline shape rather than importing @earendil-works/pi-coding-agent: this fixture only
// needs to look plausible to bin/pi-check's static rules, and pi-check itself must not gain
// a dependency on PI's types (REQ-PRV-12a: it must run on a machine without PI installed).
export const id = "example";
export function register(pi: { on: (event: string, cb: () => void) => void }) {
  pi.on("session_start", () => {
    // no-op
  });
}
