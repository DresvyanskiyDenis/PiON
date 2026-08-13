/**
 * Every path `EXT-06` touches, in one place — mirrors the layering convention already
 * established by `extensions/lib/paths.ts` (`configDir()`, `stateRoot()`, `lockDir()`).
 *
 * All four functions are env-overridable so tests never touch a real `~/.pi/agent` or
 * `~/.local/state/pi-config` ("No test may hit ... `~/.pi/agent`").
 */
import { join } from "node:path";
import { configDir, lockDir as libLockDir, stateRoot } from "../lib/paths.ts";

/** Where enqueued-but-not-yet-drained digest jobs live. */
export function queueDir(): string {
  return join(stateRoot(), "digest-queue");
}

/** The single global mutex directory `runDetached`/`releaseLock` operate on. */
export function digestLockDir(): string {
  return libLockDir("digest");
}

/**
 * `config/digest.json`, installed by symlink to `~/.pi/agent/digest.json`
 * (`config/README.md`'s pattern for every file under `config/`). `PI_DIGEST_CONFIG`
 * overrides for tests and for anyone running the drainer against a non-default tree.
 */
export function digestConfigPath(): string {
  return process.env.PI_DIGEST_CONFIG ?? join(configDir(), "digest.json");
}

/**
 * `config/routing.json`, installed the same way. `PI_ROUTING_JSON` matches the exact
 * override name `config/bin/pi-tier` already uses, so one env var controls both.
 */
export function routingConfigPath(): string {
  return process.env.PI_ROUTING_JSON ?? join(configDir(), "routing.json");
}
