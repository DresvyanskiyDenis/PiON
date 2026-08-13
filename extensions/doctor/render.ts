/**
 * The human-readable `/doctor` table. `--json` bypasses this entirely
 * (`doctor.ts` writes `JSON.stringify(report)` straight to stdout) — this module is for the
 * interactive/TUI path only.
 */
import type { DoctorReport, Finding } from "./types.ts";

const INDENT = "  ";

function summaryLines(report: DoctorReport): string[] {
  const lines: string[] = [];
  lines.push(`modules        ${report.modules.loaded}/${report.modules.declared} loaded`);

  const guardBits: string[] = [];
  if (report.guard.version !== undefined) guardBits.push(`guard ${report.guard.version}`);
  if (report.guard.gateCount !== undefined) guardBits.push(`${report.guard.gateCount} gates`);
  guardBits.push(`pattern self-test ${report.guard.selfTestOk ? "OK" : "FAILED"}`);
  if (!report.guard.moduleLoaded) guardBits.unshift("NOT LOADED");
  lines.push(`guardrails     ${guardBits.join(", ")}`);

  lines.push(`skills         ${report.skills.count} discovered`);
  lines.push(`agents         ${report.agents.count} discovered`);

  const toolPreview = report.tools.names.slice(0, 6).join(", ");
  const toolSuffix = report.tools.names.length > 6 ? ", …" : "";
  lines.push(`tools          ${report.tools.count} active (${toolPreview}${toolSuffix})`);

  const modelBits = [`${report.models.available} available`];
  if (report.models.uncredentialed.length > 0) {
    modelBits.push(
      `${report.models.uncredentialed.length} declared-but-uncredentialed (${report.models.uncredentialed.join(", ")})`,
    );
  }
  lines.push(`models         ${modelBits.join(", ")}`);

  const pkgBits = [`${report.packages.resolved}/${report.packages.declared} resolved`];
  if (report.packages.absent.length > 0) pkgBits.push(`absent: ${report.packages.absent.join(", ")}`);
  if (report.packages.versionMismatch.length > 0) pkgBits.push(`mismatched: ${report.packages.versionMismatch.join(", ")}`);
  lines.push(`packages       ${pkgBits.join(", ")}`);

  lines.push(`servers        ${report.servers.count} declared (${report.servers.names.join(", ") || "none"})`);

  // Only when broken. A healthy hook layer already shows up as a loaded module; a degraded one has
  // no other standing signal, which is the whole reason `D-09` exists.
  if (report.hooks.degradedReason !== undefined) {
    lines.push(`hooks          DEGRADED — no rules in effect (${report.hooks.degradedReason})`);
  }

  return lines;
}

function findingLines(f: Finding): string[] {
  const label = f.severity === "error" ? "error" : f.severity === "warn" ? "warn " : "ok   ";
  return [`${f.check}  ${label}  ${f.message}`, `             → ${f.action}`];
}

export function renderTable(report: DoctorReport): string {
  const lines: string[] = ["/doctor", ""];
  for (const l of summaryLines(report)) lines.push(`${INDENT}${l}`);
  lines.push("");

  const problems = report.findings.filter((f) => f.severity !== "ok");
  for (const f of problems) {
    for (const l of findingLines(f)) lines.push(`${INDENT}${l}`);
  }
  if (problems.length > 0) lines.push("");

  const errors = problems.filter((f) => f.severity === "error").length;
  const warnings = problems.filter((f) => f.severity === "warn").length;
  lines.push(
    `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`,
  );
  return lines.join("\n");
}

/** One line per non-`"ok"` finding, for `session_start`'s warn pass — `renderTable`'s body without
 *  the summary block, since the warn pass fires once per session and the summary would repeat. */
export function renderWarnLine(f: Finding): string {
  return `[doctor ${f.check}] ${f.message} — ${f.action}`;
}
