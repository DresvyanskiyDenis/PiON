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

const PI_PATH = join(homedir(), "bin", "pi");

/**
 * This one suite checks the *machine*, not the repository: it verifies that a completed install
 * put the pinned runtime where it belongs. On a clean checkout — a CI runner, or a contributor who
 * has cloned but not installed — there is nothing to verify, and failing there would train everyone
 * to ignore a red suite. So it skips with a reason instead, which `node --test` reports distinctly
 * from a pass.
 *
 * Deliberately not gated on `process.env.CI`: what matters is whether PiON is installed, and a
 * developer who has not installed it yet deserves the same clear skip a runner gets.
 */
const INSTALL_MARKER = join(
  process.env.PI_HOME ?? join(homedir(), ".pi"),
  "agent",
  ".install-mode",
);

/**
 * The distinction that matters, and the reason this is not simply `existsSync(PI_PATH)`:
 *
 *   - no `.install-mode` marker → `scripts/install.sh` never ran here. A missing `~/bin/pi` is
 *     expected, and the whole suite skips.
 *   - marker present but `~/bin/pi` missing → an install DID run and did not leave the runtime
 *     where it promised. That is a real defect and still fails, loudly, below.
 *
 * Keying on `existsSync(PI_PATH)` alone would have collapsed those two into one silent skip, which
 * is the failure mode this repository exists to avoid.
 */
const WAS_INSTALLED = existsSync(INSTALL_MARKER);
const NO_INSTALL = WAS_INSTALLED
  ? false
  : `no install marker at ${INSTALL_MARKER} — this checkout was never installed, so there is no ` +
    `machine state to verify (see docs/getting-started/install.md)`;

describe("pi runtime", { skip: NO_INSTALL }, () => {
  const piPath = PI_PATH;

  it("is installed at ~/bin/pi", () => {
    assert.ok(
      existsSync(piPath),
      `an install ran on this machine (${INSTALL_MARKER} exists) but pi is not at ${piPath}. ` +
        `Re-run the install (docs/getting-started/install.md).`,
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

/**
 * npm's platform-specific optional dependencies (`@napi-rs/keyring-darwin-arm64` and its siblings)
 * are installed only on the platform whose name they carry, so pinning them is still worth
 * asserting — but only where npm would have installed them. Elsewhere their absence is npm working
 * correctly, and asserting it anyway makes every non-macOS CI run red for no defect.
 *
 * The suffix is matched against Node's own `process.platform`/`process.arch` vocabulary, which is
 * exactly the vocabulary npm builds these package names from, so no hand-maintained platform list
 * goes stale here.
 */
const PLATFORM_SUFFIX = /-(aix|darwin|freebsd|linux|openbsd|sunos|win32|android)-(arm|arm64|ia32|loong64|mips64el|ppc|ppc64|riscv64|s390|s390x|x64)(-\w+)?$/;

function skipReasonForPlatform(name: string): string | false {
  const m = PLATFORM_SUFFIX.exec(name);
  if (!m) return false;
  const [, platform, arch] = m;
  if (platform === process.platform && arch === process.arch) return false;
  return `${name} is a ${platform}-${arch} optional dependency; this is ${process.platform}-${process.arch}, so npm correctly did not install it`;
}

describe("transitive pins resolve to their exact pin", () => {
  for (const row of packagesLock.transitive_pins) {
    it(`${row.name}@${row.version}`, { skip: skipReasonForPlatform(row.name) }, () => {
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
