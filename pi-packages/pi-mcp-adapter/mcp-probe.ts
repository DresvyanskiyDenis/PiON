const PROBE_TIMEOUT_MS = 5_000;

export interface McpProbeResult {
  isMcp: boolean;
  classification: string;
}

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pi-mcp-probe", version: "2.1.2" },
  },
};

function isJsonRpcEnvelope(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    ("result" in value || "error" in value);
}

function isBearerChallenge(response: Response): boolean {
  return /(?:^|,)\s*Bearer\b/i.test(response.headers.get("www-authenticate") ?? "");
}

function responseKind(response: Response): string {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "text/html") return "HTML";
  if (contentType) return contentType;
  return "an untyped response";
}

async function hasJsonRpcEnvelope(response: Response): Promise<boolean> {
  try {
    return isJsonRpcEnvelope(JSON.parse(await response.text()));
  } catch {
    return false;
  }
}

async function classifyResponse(response: Response, allowJson: boolean): Promise<McpProbeResult | null> {
  const isSse = response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream");
  if (response.ok && isSse) {
    return { isMcp: true, classification: "endpoint responded with an MCP event stream" };
  }

  const isJsonRpc = (allowJson || response.status === 401) && await hasJsonRpcEnvelope(response);
  if (response.ok && allowJson && isJsonRpc) {
    return { isMcp: true, classification: "endpoint responded with a JSON-RPC 2.0 envelope" };
  }
  if (response.status === 401 && isBearerChallenge(response) && isJsonRpc) {
    return { isMcp: true, classification: "endpoint requires Bearer authentication and responded with a JSON-RPC 2.0 error" };
  }

  return null;
}

function notMcp(response: Response): McpProbeResult {
  return {
    isMcp: false,
    classification: `endpoint returned ${responseKind(response)} (${response.status}) — this URL does not appear to speak MCP`,
  };
}

/** Makes one unauthenticated metadata-only request to identify an HTTP endpoint's protocol shape. */
export async function probeMcpEndpoint(url: string | URL): Promise<McpProbeResult> {
  const postResponse = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(INITIALIZE_REQUEST),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const postClassification = await classifyResponse(postResponse, true);
  if (postClassification) return postClassification;

  if (![404, 405, 406, 415].includes(postResponse.status)) return notMcp(postResponse);

  const getResponse = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const getClassification = await classifyResponse(getResponse, false);
  return getClassification ?? notMcp(getResponse);
}
