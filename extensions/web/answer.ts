/**
 * `EXT-07` — `web_answer`: search that reads the pages and answers, instead of listing links.
 *
 * `web_search` returns ten titles and snippets and leaves the agent to pick, `web_fetch` them one
 * at a time, and reconcile what they said. That is three or more round trips of context for a
 * question whose answer is one paragraph. `web_answer` pushes the whole loop to the search host:
 * it searches, screens the results, opens the surviving top pages, and returns a written answer
 * with `[n]` citations plus the source list those markers point at — one tool call, one result,
 * pages that were actually read.
 *
 * It does NOT replace `web_search`. Use `web_search` when the answer is *which page*, when the
 * agent wants to choose what to read itself, or when the query is navigational ("the repo for X").
 * Use `web_answer` when the answer is a fact, a version, a config key, or a comparison — anything
 * where the useful output is prose rather than a link.
 *
 * Off unless you point it at something
 * ------------------------------------
 * A stock SearXNG serves `/search` and nothing else; search-read-and-cite is a second endpoint you
 * put in front of it, and most installs will not have one. So this tool is **opt-in by address**:
 * `web.json`'s `search.answerPath` ships `null`, and while it is unset `register()` does not
 * create the tool at all. That is a configuration answer, not a failure — the same shape as
 * answering "none" at install time removing `web_search` cleanly rather than leaving it to break
 * at the first call.
 *
 * When the path *is* set, the host it is joined to is `web-search.json`'s `searxngBaseUrl` — the
 * one `web_search` already uses. Reusing it means there is exactly one address to keep correct,
 * and the request rides the same global fetch dispatcher `./proxy.ts` installs, so a corporate
 * proxy and a custom CA bundle apply here as they do everywhere else.
 *
 * Fail loud, no fallback
 * ----------------------
 * If the answer engine is unreachable this throws, and the agent still has `web_search` and
 * `web_fetch` in the same session to fall back to by itself. A throw costs one turn and the model
 * routes around it, so silently returning a different, weaker thing would be strictly worse than
 * saying what happened.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configDir } from "../lib/paths.ts";

/** Synthesis opens up to `k` pages and then runs a reasoning model over all of them; it is a
 *  minute-scale operation, not a request-scale one. This ceiling sits just under the five minutes
 *  such an endpoint typically allows itself — a client timeout that fires first would discard an
 *  answer the server did produce. */
const REQUEST_TIMEOUT_MS = 290_000;

/** Pages the engine opens and reads. Below ~4 a single bad result dominates the answer; above ~10
 *  the extra pages mostly repeat and the synthesis prompt starts crowding out the good ones. */
const K_MIN = 3;
const K_MAX = 10;
const K_DEFAULT = 6;

interface AnswerSource {
  readonly n?: number;
  readonly title?: string;
  readonly url?: string;
}

interface AnswerResponse {
  readonly answer?: string;
  readonly sources?: readonly AnswerSource[];
  readonly read?: number;
  readonly found?: number;
  readonly vet_error?: string | null;
}

function readJson(path: string, what: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `web_answer: ${what} not found at ${path}, so there is no configured search host to ask. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `web_answer: ${what} at ${path} is not valid JSON: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/** The configured path, or `""` when the operator has not named one. Never throws: an absent or
 *  unreadable `web.json` means the tool is simply not on, which is a legitimate state. */
function configuredAnswerPath(): string {
  let doc: Record<string, unknown>;
  try {
    doc = readJson(join(configDir(), "web.json"), "web.json");
  } catch {
    return "";
  }
  const search = doc.search;
  if (typeof search !== "object" || search === null) return "";
  const path = (search as Record<string, unknown>).answerPath;
  return typeof path === "string" ? path.trim() : "";
}

/** Whether `web.json` names an answer endpoint at all — the gate `register()` uses to decide
 *  whether this tool exists in the session. */
export function answerRequested(): boolean {
  return configuredAnswerPath() !== "";
}

/** The full answer endpoint: `web.json`'s `search.answerPath` joined to the same host
 *  `web-search.json`'s `searxngBaseUrl` gives `web_search`. Throws with the reason when either
 *  half is missing — by the time this is called the operator has already asked for the tool. */
export function answerEndpoint(): string {
  const path = configuredAnswerPath();
  if (!path) {
    throw new Error(
      "web_answer: web.json has no \"search.answerPath\", so no answer endpoint is configured. " +
        "Set it to the path your search host serves search-read-and-cite on (for example " +
        '"/answer"), or keep using web_search.',
    );
  }
  const wsPath = join(configDir(), "web-search.json");
  const parsed = readJson(wsPath, "web-search.json");
  const base = typeof parsed.searxngBaseUrl === "string" ? parsed.searxngBaseUrl.trim() : "";
  if (!base) {
    throw new Error(
      `web_answer: web-search.json at ${wsPath} has no "searxngBaseUrl". web_answer reuses the ` +
        "same host as web_search; set it there rather than adding a second address to keep in step.",
    );
  }
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Renders the engine's reply as the text the model reads: answer first, then the numbered
 *  sources its `[n]` markers refer to, so a citation can be followed without a second tool call. */
export function formatAnswer(data: AnswerResponse): string {
  const answer = (data.answer ?? "").trim();
  const sources = data.sources ?? [];
  const lines = [answer];
  if (sources.length > 0) {
    lines.push("", "Sources (cited as [n] above):");
    for (const s of sources) {
      lines.push(`  [${s.n ?? "?"}] ${s.title ?? "(untitled)"} — ${s.url ?? "(no url)"}`);
    }
  }
  if (data.vet_error) {
    // Surfaced, not swallowed: the answer is still built from real pages, but result screening
    // was skipped for it, so more of what got read may be off topic than usual.
    lines.push("", `NOTE: upstream result screening was unavailable (${data.vet_error}).`);
  }
  return lines.join("\n");
}

export function registerAnswerTool(pi: ExtensionAPI): void {
  if (!answerRequested()) return;

  pi.registerTool({
    name: "web_answer",
    label: "Web answer (search + read + cite)",
    description:
      "Ask the web a question and get a written, cited answer. Searches, opens the top pages, " +
      "reads them, and returns prose with [n] citations plus the sources those markers point at. " +
      "Prefer this over web_search when what you need is a fact, a version, a default, a config " +
      "key, or a comparison. Use web_search instead when you need to choose which page to open, " +
      "or when the query is navigational.",
    promptSnippet: "Ask the web a question and get a cited answer built from pages that were read",
    promptGuidelines: [
      "For a factual web question, call web_answer once instead of web_search followed by several web_fetch calls.",
      "Cite web_answer's [n] markers back to the source list it returns; do not attribute a claim to a page that is not in that list.",
      "The question may be prefixed with a SearXNG engine bang to restrict the search to one source: !arxiv (preprints), !crossref / !oa (published papers), !gh (code), !dh (Docker images), !mdn (web platform docs), !so (Stack Overflow). Use one only when the question names the kind of source it wants — a bang disables result fusion across engines, which is where answer quality normally comes from, so an ordinary question is better served without one.",
    ],
    parameters: Type.Object({
      q: Type.String({
        description:
          "The question, in natural language. Not keywords. May start with a SearXNG " +
          "engine bang (e.g. `!arxiv `) to search one source instead of all of them.",
      }),
      k: Type.Optional(
        Type.Integer({
          minimum: K_MIN,
          maximum: K_MAX,
          default: K_DEFAULT,
          description: "How many pages to open and read.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const endpoint = answerEndpoint();
      const q = params.q.trim();
      if (!q) throw new Error("web_answer: `q` is empty — nothing to ask.");

      // Two abort sources, one signal: the agent's own cancellation and this tool's ceiling.
      // Without the timeout leg a hung engine would hold the turn open indefinitely.
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ q, k: params.k ?? K_DEFAULT }),
          signal: combined,
        });
      } catch (err) {
        // Distinguish "you cancelled" from "the box is unreachable" — the second is the one that
        // means go use web_search instead, and conflating them sends the agent retrying a cancel.
        if (signal?.aborted) throw new Error("web_answer: cancelled.");
        if (timeout.aborted) {
          throw new Error(
            `web_answer: no response from ${endpoint} within ${REQUEST_TIMEOUT_MS / 1000}s.`,
          );
        }
        throw new Error(
          `web_answer: could not reach the answer engine at ${endpoint} ` +
            `(${err instanceof Error ? err.message : String(err)}). web_search is still available.`,
          { cause: err },
        );
      }

      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 400);
        throw new Error(
          `web_answer: ${endpoint} returned HTTP ${res.status}${body ? ` — ${body}` : ""}. ` +
            "web_search is still available.",
        );
      }

      let data: AnswerResponse;
      try {
        data = (await res.json()) as AnswerResponse;
      } catch (err) {
        throw new Error(
          `web_answer: ${endpoint} returned a body that is not JSON ` +
            `(${err instanceof Error ? err.message : String(err)}).`,
          { cause: err },
        );
      }

      if (!(data.answer ?? "").trim()) {
        throw new Error(
          "web_answer: the engine returned no answer — it found results but could not read any " +
            "page, or synthesis produced nothing. Try web_search for this query.",
        );
      }

      return {
        content: [{ type: "text" as const, text: formatAnswer(data) }],
        details: {
          endpoint,
          read: data.read ?? null,
          found: data.found ?? null,
          sources: (data.sources ?? []).map((s) => s.url ?? ""),
        },
      };
    },
  });
}
