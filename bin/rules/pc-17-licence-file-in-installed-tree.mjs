/** @typedef {import("../types.mjs").Finding} Finding */
/** @typedef {import("../types.mjs").RuleContext} RuleContext */
import { readPackagesLock, installedPackageDir, findLicenseFile } from "../lib/packages.mjs";

export const id = "PC-17";
export const title = "Every installed/vendored package tree ships a licence file (or the ledger says why not)";
export const tags = ["packages"];
export const closes = ["REQ-PRV-48"];

/** @param {RuleContext} ctx @returns {Finding[]} */
export function run(ctx) {
  const lock = readPackagesLock(ctx);
  if ("error" in lock) {
    return [{ rule: id, file: "config/packages.lock.json", message: lock.error }];
  }

  /** @type {Finding[]} */
  const findings = [];
  for (const entry of lock.entries) {
    if (typeof entry?.name !== "string") continue;
    const dir = installedPackageDir(ctx, entry.name);
    if (!dir) continue; // not on disk yet — a lock entry may be reviewed before it is installed

    if (findLicenseFile(dir.absDir)) continue;

    let fieldLicense = null;
    const pkgJsonRel = `${dir.relDir}/package.json`;
    if (ctx.exists(pkgJsonRel)) {
      try {
        const pkgJson = ctx.readJSON(pkgJsonRel);
        fieldLicense = typeof pkgJson?.license === "string" ? pkgJson.license : null;
      } catch {
        // a malformed installed package.json is not this rule's concern
      }
    }

    if (fieldLicense) {
      // This rule's title has two halves: "ships a licence file (OR THE LEDGER SAYS WHY NOT)".
      // The second half had no implementation — the lock file had no field for it — so the three
      // packages docs/PACKAGES.md trap 2 already reviewed and accepted ("a licence file absent
      // from the tarball is not a missing licence"; they exclude it via package.json `files`)
      // reported forever, which made `--all` permanently red and install.sh step 8 permanently
      // fatal. `licenseTextShipped: false` in config/packages.lock.json is that ledger entry: an
      // explicit, reviewed, per-package acknowledgement. A NEW package with no licence text still
      // fires, because it will not carry the field.
      if (entry.licenseTextShipped === false) continue;
      findings.push({
        rule: id,
        file: dir.relDir,
        message: `no LICENSE/LICENCE file in the installed tree; package.json declares "license": "${fieldLicense}" — a declared-but-textless licence (docs/PACKAGES.md trap 2); confirm docs/PACKAGES.md's "${entry.name}" row still records this before treating it as urgent`,
      });
    } else {
      findings.push({
        rule: id,
        file: dir.relDir,
        message: `no LICENSE/LICENCE file in the installed tree and no "license" field in package.json — this should not have cleared docs/PACKAGES.md's review; see docs/DENYLIST.md §2 (Licence)`,
      });
    }
  }
  return findings;
}
