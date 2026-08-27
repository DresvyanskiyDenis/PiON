/**
 * `EXT-07` — provider-independent `web_search` / `web_fetch`, and a `web_answer` that reads the
 * pages and cites them (`REQ-EXT-50`, `-51`).
 *
 * `pi-web-access@0.18.0` is adopted wholesale (the earlier "keep
 * custom" verdict is reversed) and registers its own tools via its own `pi.extensions` entry, wired
 * through `settings.json`'s `packages` array. This
 * module owns the four things the package adoption does *not* cover, and adds a fifth tool of its
 * own:
 *
 *   1. **Pinning exactly one search backend**, enforced at every `session_start`, not just declared
 *      in a config file nobody re-checks (`./web/config-guard.ts`).
 *   2. **Corporate proxy + CA bundle plumbing** into the package's fetch path — zero packages
 *      address this, `HTTPS_PROXY` is not honoured by the standalone `pi` binary on its own
 *      (verified empirically, see `./web/proxy.ts`) (`./web/proxy.ts`).
 *   3. **Denying the browser-cookie credential path** stays true. `pi-web-access` ships
 *      `chrome-cookies.ts`, scoped to three Google origins and off by default; `bin/pi-check`'s
 *      `PC-14` rule (`EXT-04a`) already asserts `PI_ALLOW_BROWSER_COOKIES` /
 *      `FEYNMAN_ALLOW_BROWSER_COOKIES` stay unset in `config/shell/pi-env.sh`, `config/settings.json`
 *      and the ambient environment — nothing further is built here, this file only relies on it.
 *   4. **Aliasing `fetch_content` (the package's default tool name) to `web_fetch`** (the name the
 *      ported `AGENTS.md`'s TRIGGER blocks and the `sofa` skill already call), enforced the same way
 *      as the backend pin — see `./web/config-guard.ts`'s `assertFetchToolAliasedToWebFetch`.
 *
 *   5. **A `web_answer` tool** (`./web/answer.ts`) — search that opens the top pages and returns a
 *      cited answer instead of a link list, served by the same host `searxngBaseUrl` already names.
 *      Registered in `register()` rather than `session_start`: a tool has to exist before the
 *      session it is offered to does, and PI has no way to withdraw one afterwards.
 *
 * `register()` starts no timers, sockets or watchers — the factory also runs in invocations that
 * never open a session (`pi --list-models`). Its one piece of I/O is `registerAnswerTool`'s read of
 * `web.json`, which decides whether `web_answer` exists at all; that read has to happen here for
 * the reason just given, and an absent or unreadable file simply means the tool is off. Everything
 * else (the config asserts, installing the network dispatcher) is in `session_start`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitNotice } from "./lib/announce.ts";
import { declareModule } from "./lib/manifest.ts";
import {
  assertFetchToolAliasedToWebFetch,
  assertPinnedSearchBackend,
  type PinnedBackendCheck,
} from "./web/config-guard.ts";
import { installNetworkDispatcher } from "./web/proxy.ts";
import { registerAnswerTool } from "./web/answer.ts";

export const id = "web";
const MODULE_VERSION = "1.0.0";

export function register(pi: ExtensionAPI): void {
  registerAnswerTool(pi);

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    // F6 fix (adversarial security review): the proxy/CA plumbing has to land BEFORE the
    // asserts below, unconditionally. A `throw` from PI's `session_start` runner is caught and
    // routed to `emitError` — the session CONTINUES — so the old ordering (asserts, then
    // `installNetworkDispatcher()`) meant a refusal also silently meant "and the corporate
    // proxy/CA bundle never got installed for whatever ran before someone noticed the error."
    const net = installNetworkDispatcher();

    // Same reason, the actual refusal: a `throw` here is caught by PI's runner too, so this
    // module must not rely on throwing to stop the session — it has to call `ctx.shutdown()`
    // itself, the pattern `extensions/hooks/index.ts`'s `refuse()` and `extensions/doctor.ts`'s
    // D-06 branch already use. Each assert is wrapped separately so the failure names exactly
    // which one refused; the underlying error message already carries the two disagreeing
    // config values (see `config-guard.ts`'s own throw text), so it is reused verbatim.
    const refuse = (assertion: string, err: unknown): void => {
      const detail = err instanceof Error ? err.message : String(err);
      const msg = `web: EXT-07's config-guard (${assertion}) refused to start this session — ${detail}`;
      // One channel, not both: `emitNotice` picks the TUI or stderr by `ctx.hasUI` and swallows a
      // broken dialog subsystem, so the shutdown below always runs — same reasoning as
      // hooks/index.ts's announce(), minus the duplicate stderr copy in the TUI.
      emitNotice(ctx, `[pi-config] ${msg}`, "error");
      ctx.shutdown();
    };

    let pinned: PinnedBackendCheck;
    try {
      pinned = assertPinnedSearchBackend();
    } catch (err) {
      refuse("assertPinnedSearchBackend", err);
      return;
    }

    try {
      assertFetchToolAliasedToWebFetch();
    } catch (err) {
      refuse("assertFetchToolAliasedToWebFetch", err);
      return;
    }

    if (net.proxied || net.extraCa) {
      process.stderr.write(
        `[pi-config] web: backend="${pinned.backend}", proxy=${net.proxied}, extraCa=${net.extraCa}\n`,
      );
    }

    declareModule({
      id,
      version: MODULE_VERSION,
      events: ["session_start"],
      apis: ["on"],
    });
  });
}
