// fetch wrapper that turns every failure into a typed ApiError. `fetchImpl` is injected so tests
// (and nothing else) can fake the network. No DOM, no globals besides fetch/AbortController.
const MAX_REASON_LENGTH = 500;

export class ApiError extends Error {
  // kind: "rate-limit" | "server" | "timeout" | "network" | "bad-response" | "api-error"
  constructor(kind, message, { status, reason, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ApiError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (reason !== undefined) this.reason = reason;
  }
}

// Open-Meteo reports problems as {"error": true, "reason": "..."}, with HTTP 400 for bad requests
// (confirmed on real captures, see PLAN.md M2 findings). The reason is data, so bound it.
function reasonOf(body) {
  if (!body || typeof body !== "object" || body.error !== true) return undefined;
  return typeof body.reason === "string" ? body.reason.slice(0, MAX_REASON_LENGTH) : "";
}

function classifyFetchFailure(err, controller) {
  if (controller.signal.aborted || err?.name === "AbortError") {
    return new ApiError("timeout", "The request timed out", { cause: err });
  }
  return new ApiError("network", "The network request failed", { cause: err });
}

export async function fetchJson(url, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status;
  let text;
  try {
    // The timer covers reading the body too, so a stalled download times out rather than hanging.
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      status = res.status;
      text = await res.text();
    } catch (err) {
      throw classifyFetchFailure(err, controller);
    }
  } finally {
    clearTimeout(timer);
  }

  let body;
  let parsed = true;
  try {
    body = JSON.parse(text);
  } catch {
    parsed = false;
  }
  const reason = parsed ? reasonOf(body) : undefined;

  if (status === 429) throw new ApiError("rate-limit", "Rate limited (HTTP 429)", { status, reason });
  if (status >= 500) throw new ApiError("server", `Server error (HTTP ${status})`, { status, reason });
  if (status < 200 || status >= 300) {
    if (reason !== undefined) throw new ApiError("api-error", `Rejected: ${reason}`, { status, reason });
    throw new ApiError("bad-response", `Unexpected HTTP ${status}`, { status });
  }
  if (!parsed) throw new ApiError("bad-response", "Response was not valid JSON", { status });
  if (reason !== undefined) throw new ApiError("api-error", `Rejected: ${reason}`, { status, reason });
  return body;
}
