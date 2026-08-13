/**
 * Bootstrap regression test.
 *
 * Asserts the three things the Bootstrap phase established, so that a later
 * `npm install`, a package bump or a PI upgrade cannot silently drift:
 *
 *   1. the pinned PI runtime is installed and reports exactly the pinned version
 *   2. every adopted package in config/packages.lock.json resolved to its exact pin
 *   3. every rejected package (DENYLIST / not_installed) is absent from node_modules
 *
 * Run: node --test test/bootstrap.test.ts
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE_MODULES = join(REPO, "node_modules");

interface PackageRow {
  name: string;
  version: string;
  license: string;
}
interface PackagesLock {
  packages: PackageRow[];
  transitive_pins: PackageRow[];
  not_installed: { name: string; version: string; reason: string }[];
}
interface ReleaseLock {
  version: string;
  npm: { package: string; spec: string };
}

const packagesLock = JSON.parse(
  readFileSync(join(REPO, "config", "packages.lock.json"), "utf8"),
) as PackagesLock;
const releaseLock = JSON.parse(
  readFileSync(join(REPO, "config", "pi-release.lock"), "utf8"),
) as ReleaseLock;

/** Installed version of `name`, or null when the package is absent. */
function installedVersion(name: string): string | null {
  const manifest = join(NODE_MODULES, name, "package.json");
  if (!existsSync(manifest)) return null;
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
}

describe("pi runtime", () => {
  const piPath = join(homedir(), "bin", "pi");

  it("is installed at ~/bin/pi", () => {
    assert.ok(
      existsSync(piPath),
      `pi is not installed at ${piPath}. Re-run the install (docs/getting-started/install.md).`,
    );
  });

  it("reports exactly the pinned version, offline", () => {
    const out = execFileSync(piPath, ["--version"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
      },
    }).trim();
    assert.equal(
      out,
      releaseLock.version,
      `pi --version reported "${out}", config/pi-release.lock pins "${releaseLock.version}"`,
    );
  });
});

describe("adopted packages resolve to their exact pin", () => {
  for (const row of packagesLock.packages) {
    it(`${row.name}@${row.version}`, () => {
      const got = installedVersion(row.name);
      assert.notEqual(got, null, `${row.name} is not installed in ${NODE_MODULES}`);
      assert.equal(got, row.version, `${row.name}: installed ${got}, pinned ${row.version}`);
    });
  }

  it("the PI type package matches the release pin", () => {
    assert.equal(installedVersion(releaseLock.npm.package), releaseLock.version);
  });
});

describe("transitive pins resolve to their exact pin", () => {
  for (const row of packagesLock.transitive_pins) {
    it(`${row.name}@${row.version}`, () => {
      const got = installedVersion(row.name);
      assert.notEqual(got, null, `${row.name} is not installed in ${NODE_MODULES}`);
      assert.equal(got, row.version, `${row.name}: installed ${got}, pinned ${row.version}`);
    });
  }
});

describe("rejected packages are absent", () => {
  for (const row of packagesLock.not_installed) {
    it(`${row.name} is not installed — ${row.reason.split(".")[0]}`, () => {
      assert.equal(
        installedVersion(row.name),
        null,
        `${row.name} must never be installed: ${row.reason}`,
      );
    });
  }
});
