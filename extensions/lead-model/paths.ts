/**
 * Where a project's lead-model pin lives.
 *
 * `<project>/.pi/lead-model.json`, a sibling of the `<project>/.pi/settings.json` PI already
 * reads. A project-scoped decision belongs in the project's own `.pi/` directory, resolved as
 * `join(cwd, ".pi", <name>)` with no walk up the tree.
 *
 * The absence of a walk-up is the deliberate part. A pin that a subdirectory silently inherits
 * from three levels up is a pin nobody can see from where they are standing, and this module's
 * whole job is to make a decision visible. The session's `cwd` is the project, which is how PI
 * already treats it for `.pi/settings.json`.
 *
 * `PI_LEAD_MODEL_JSON` overrides the whole resolution — for tests, and for anyone driving a
 * project tree from somewhere else. The same shape of override as `PI_PATH_DEFAULTS_JSON` in
 * `extensions/path-defaults/paths.ts`.
 */
import { join } from "node:path";

export const LEAD_MODEL_FILE = "lead-model.json";

/** The pin file for the project rooted at `cwd`. */
export function leadModelPinPath(cwd: string): string {
  return process.env.PI_LEAD_MODEL_JSON ?? join(cwd, ".pi", LEAD_MODEL_FILE);
}
