// EXT-09 — the Copilot quota read path: the ported field-shape parser plus fetchQuota's HTTP
// handling. No mocking library: fetchQuota takes its URL as a parameter (same technique
// extensions/lib/local-catalogue.ts's fetchLiveModelIds tests use), so these spin up a real
// node:http server rather than faking `fetch`.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, it } from "node:test";
import {
  describeSnapshot,
  fetchQuota,
  normalizeCopilotQuota,
  QuotaUnavailable,
  render,
} from "../../extensions/quota/copilot.ts";

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}/copilot_internal/user`;
}

function jsonServer(status: number, body: unknown): Promise<string> {
  return listen((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
}

/* --------------------------------------------------------------------------------------------- *
 * normalizeCopilotQuota — the real tenant shapes
 * --------------------------------------------------------------------------------------------- */

describe("normalizeCopilotQuota", () => {
  it("Copilot Business / GHE, unlimited + token-based billing (the recorded V-13 fact) -> 'unlimited', no fabricated number", () => {
    const s = normalizeCopilotQuota(
      {
        login: "octocat",
        copilot_plan: "business",
        quota_snapshots: { premium_interactions: { unlimited: true, token_based_billing: true } },
      },
      1000,
    );
    assert.equal(s.kind, "unlimited");
    assert.equal(s.id, "ai_credits");
    assert.equal(s.label, "AI credits");
    assert.equal(s.plan, "business");
    assert.equal(s.remainingPct, undefined);
    assert.equal(s.used, undefined);
    assert.equal(s.limit, undefined);
  });

  it("legacy premium requests, finite, low remaining -> 'metered', 8% (wave2-specs.md §5.4 step 4's example)", () => {
    // quota_reset_date_utc is a top-level payload field upstream (github-copilot.ts's
    // resetTimestamp reads `payload.quota_reset_date_utc`, not premium_interactions.*) — not
    // nested under premium_interactions, matching normalizeCopilotQuota's own resetTimestamp(root).
    const s = normalizeCopilotQuota(
      {
        copilot_plan: "business",
        quota_reset_date_utc: "2026-09-01T00:00:00Z",
        quota_snapshots: {
          premium_interactions: {
            token_based_billing: false,
            unlimited: false,
            entitlement: 300,
            remaining: 24,
          },
        },
      },
      1000,
    );
    assert.equal(s.kind, "metered");
    assert.equal(s.id, "premium_requests");
    assert.equal(s.used, 276);
    assert.equal(s.limit, 300);
    assert.equal(s.remainingPct, 8);
    assert.equal(s.resetsAt, "2026-09-01T00:00:00Z");
  });

  it("token-based billing, finite (post-2026-06-01 AI credits, not unlimited) -> 'ai_credits'", () => {
    const s = normalizeCopilotQuota(
      { quota_snapshots: { premium_interactions: { token_based_billing: true, unlimited: false, entitlement: 1000, remaining: 850 } } },
      1000,
    );
    assert.equal(s.id, "ai_credits");
    assert.equal(s.used, 150);
    assert.equal(s.remainingPct, 85);
  });

  it("free-tier fallback (no premium_interactions at all) -> chat_requests", () => {
    const s = normalizeCopilotQuota({ limited_user_quotas: { chat: 40 }, monthly_quotas: { chat: 50 } }, 1000);
    assert.equal(s.kind, "metered");
    assert.equal(s.id, "chat_requests");
    assert.equal(s.used, 10);
    assert.equal(s.limit, 50);
    assert.equal(s.remainingPct, 80);
  });

  it("credits_used, when present, wins over the entitlement-minus-remaining computation", () => {
    const s = normalizeCopilotQuota(
      { quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 100, credits_used: 250 } } },
      1000,
    );
    assert.equal(s.used, 250); // not 200 (300 - 100)
  });

  it("no supported shape at all -> QuotaUnavailable, not a silent zero", () => {
    assert.throws(() => normalizeCopilotQuota({ hello: "world" }, 1000), QuotaUnavailable);
  });

  it("premium_interactions present but missing entitlement/remaining -> QuotaUnavailable", () => {
    assert.throws(
      () => normalizeCopilotQuota({ quota_snapshots: { premium_interactions: { unlimited: false } } }, 1000),
      QuotaUnavailable,
    );
  });

  it("not a JSON object -> QuotaUnavailable", () => {
    assert.throws(() => normalizeCopilotQuota([1, 2, 3], 1000), QuotaUnavailable);
    assert.throws(() => normalizeCopilotQuota(null, 1000), QuotaUnavailable);
    assert.throws(() => normalizeCopilotQuota("nope", 1000), QuotaUnavailable);
  });

  it("an unparsable reset date is dropped, not thrown", () => {
    const s = normalizeCopilotQuota(
      { quota_snapshots: { premium_interactions: { entitlement: 10, remaining: 5, quota_reset_date: "not-a-date" } } },
      1000,
    );
    assert.equal(s.resetsAt, undefined);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * fetchQuota — the HTTP half
 * --------------------------------------------------------------------------------------------- */

describe("fetchQuota", () => {
  it("parses a real 200 response", async () => {
    const url = await jsonServer(200, { quota_snapshots: { premium_interactions: { unlimited: true, token_based_billing: true } } });
    const s = await fetchQuota("ghp_test", AbortSignal.timeout(2000), url);
    assert.equal(s.kind, "unlimited");
  });

  it("404 (the V-13 'endpoint does not exist for this tenant shape' outcome) -> QuotaUnavailable, named with the status", async () => {
    const url = await jsonServer(404, { message: "Not Found" });
    await assert.rejects(fetchQuota("ghp_test", AbortSignal.timeout(2000), url), (err: unknown) => {
      assert.ok(err instanceof QuotaUnavailable);
      assert.match((err as Error).message, /404/);
      return true;
    });
  });

  it("403 -> QuotaUnavailable", async () => {
    const url = await jsonServer(403, { message: "Forbidden" });
    await assert.rejects(fetchQuota("ghp_test", AbortSignal.timeout(2000), url), QuotaUnavailable);
  });

  it("500 -> QuotaUnavailable (not just 404/403 are handled)", async () => {
    const url = await jsonServer(500, { message: "oops" });
    await assert.rejects(fetchQuota("ghp_test", AbortSignal.timeout(2000), url), QuotaUnavailable);
  });

  it("invalid JSON body -> QuotaUnavailable", async () => {
    const url = await listen((_req, res) => {
      res.statusCode = 200;
      res.end("{not json");
    });
    await assert.rejects(fetchQuota("ghp_test", AbortSignal.timeout(2000), url), QuotaUnavailable);
  });

  it("connection refusal -> QuotaUnavailable, never a bare network exception", async () => {
    await assert.rejects(
      fetchQuota("ghp_test", AbortSignal.timeout(2000), "http://127.0.0.1:1/copilot_internal/user"),
      QuotaUnavailable,
    );
  });
});

/* --------------------------------------------------------------------------------------------- *
 * render / describeSnapshot — the honest-em-dash contract (REQ-PRV-23)
 * --------------------------------------------------------------------------------------------- */

describe("render", () => {
  it("metered, above the icon threshold", () => {
    assert.equal(render({ kind: "metered", id: "premium_requests", label: "Premium requests", remainingPct: 84, fetchedAt: 0 }), "quota 84%");
  });
  it("metered, at or below 10% gets the warning icon", () => {
    assert.equal(render({ kind: "metered", id: "premium_requests", label: "Premium requests", remainingPct: 8, fetchedAt: 0 }), "⚠ quota 8%");
  });
  it("unlimited never renders a fabricated 100%", () => {
    assert.equal(render({ kind: "unlimited", id: "ai_credits", label: "AI credits", fetchedAt: 0 }), "quota —");
  });
});

describe("describeSnapshot", () => {
  it("metered includes the underscored id, used/limit, percent and reset", () => {
    const text = describeSnapshot({
      kind: "metered",
      id: "premium_requests",
      label: "Premium requests",
      used: 276,
      limit: 300,
      remainingPct: 8,
      resetsAt: "2026-09-01T00:00:00Z",
      fetchedAt: 0,
    });
    assert.match(text, /premium_requests/);
    assert.match(text, /276\/300 used/);
    assert.match(text, /8% left/);
    assert.match(text, /resets 2026-09-01T00:00:00Z/);
  });

  it("unlimited says so plainly, never a percentage", () => {
    const text = describeSnapshot({ kind: "unlimited", id: "ai_credits", label: "AI credits", plan: "business", fetchedAt: 0 });
    assert.match(text, /ai_credits/);
    assert.match(text, /unlimited, token-based billing/);
    assert.match(text, /plan business/);
    assert.doesNotMatch(text, /%/);
  });
});
