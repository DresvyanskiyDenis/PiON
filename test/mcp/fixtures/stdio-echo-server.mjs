#!/usr/bin/env node
// Fixture for test/mcp/stdio-env.test.ts (EXT-14b).
//
// Stands in for a real stdio MCP server (playwright/drawio) without spawning either — no npx,
// no network, no package install. On start it prints its own pid and every environment variable
// it can see, one per line, then stays alive until signalled. That is everything the two things
// EXT-14b's tests need to observe: (1) which env vars actually reached the real server process
// underneath mcp-stdio-guard's `exec`, and (2) whether that process is running at the SAME pid the
// wrapper was spawned with (proof that `exec` replaced the process image in place rather than
// forking a child the SDK's close() would fail to reach).
process.stdout.write(`PID:${process.pid}\n`);
for (const [key, value] of Object.entries(process.env)) {
  process.stdout.write(`ENV:${key}=${value}\n`);
}
process.stdout.write("READY\n");

// No custom signal handlers: Node's default SIGTERM disposition is to terminate, which is exactly
// what the test needs to observe (a bare `kill(pid, "SIGTERM")` reaching the real process).
setInterval(() => {}, 60_000);
