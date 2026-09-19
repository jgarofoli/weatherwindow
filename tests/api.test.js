import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchJson, ApiError } from "../docs/lib/api.js";

const FIX = new URL("./fixtures/", import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIX), "utf8");
const respond = (body, init = {}) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), init);
const kindOf = async (fetchImpl, opts = {}) => {
  try {
    await fetchJson("https://example.test/x", { fetchImpl, ...opts });
  } catch (e) {
    assert.ok(e instanceof ApiError, `expected ApiError, got ${e}`);
    return e;
  }
  assert.fail("expected fetchJson to throw");
};

test("200 with JSON -> parsed body", async () => {
  const body = await fetchJson("https://example.test/x", { fetchImpl: respond({ a: 1 }, { status: 200 }) });
  assert.deepEqual(body, { a: 1 });
});

test("the real forecast fixture passes through untouched", async () => {
  const text = fixture("forecast-new-york.json");
  const body = await fetchJson("https://example.test/x", { fetchImpl: respond(text, { status: 200 }) });
  assert.deepEqual(body, JSON.parse(text));
});

test("passes the url and an abort signal to fetch", async () => {
  let seen;
  await fetchJson("https://example.test/y?q=1", {
    fetchImpl: async (url, init) => { seen = { url, signal: init?.signal }; return new Response("{}"); },
  });
  assert.equal(seen.url, "https://example.test/y?q=1");
  assert.ok(seen.signal instanceof AbortSignal);
});

test("429 -> rate-limit", async () => {
  const e = await kindOf(respond({ error: true, reason: "Too many requests" }, { status: 429 }));
  assert.equal(e.kind, "rate-limit");
  assert.equal(e.status, 429);
});

test("429 with a non-JSON body is still rate-limit", async () => {
  assert.equal((await kindOf(respond("slow down", { status: 429 }))).kind, "rate-limit");
});

test("500 / 502 / 503 -> server", async () => {
  for (const status of [500, 502, 503]) {
    const e = await kindOf(respond("oops", { status }));
    assert.equal(e.kind, "server", String(status));
    assert.equal(e.status, status);
  }
});

test("abort by our timeout -> timeout", async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
  const t0 = Date.now();
  const e = await kindOf(hang, { timeoutMs: 30 });
  assert.equal(e.kind, "timeout");
  assert.ok(Date.now() - t0 < 2000);
});

test("timeout also covers a body that never finishes arriving", async () => {
  const stall = async (url, { signal }) => ({
    ok: true,
    status: 200,
    text: () => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
  });
  assert.equal((await kindOf(stall, { timeoutMs: 30 })).kind, "timeout");
});

test("fetch rejection (offline, DNS, CORS) -> network", async () => {
  const e = await kindOf(async () => { throw new TypeError("Failed to fetch"); });
  assert.equal(e.kind, "network");
  assert.ok(e.cause instanceof TypeError);
});

test("200 with a non-JSON body -> bad-response", async () => {
  assert.equal((await kindOf(respond("<html>captive portal</html>", { status: 200 }))).kind, "bad-response");
  assert.equal((await kindOf(respond("", { status: 200 }))).kind, "bad-response");
});

test("200 with an error payload -> api-error carrying the reason", async () => {
  const e = await kindOf(respond({ error: true, reason: "Something is off" }, { status: 200 }));
  assert.equal(e.kind, "api-error");
  assert.equal(e.reason, "Something is off");
});

test("real 400 payloads (bad latitude, bad variable) -> api-error with the API's reason", async () => {
  for (const name of ["error-bad-lat.json", "error-bad-variable.json"]) {
    const text = fixture(name);
    const e = await kindOf(respond(text, { status: 400 }));
    assert.equal(e.kind, "api-error", name);
    assert.equal(e.reason, JSON.parse(text).reason, name);
    assert.equal(e.status, 400);
  }
});

test("a 4xx without a usable error payload -> bad-response", async () => {
  assert.equal((await kindOf(respond("Not found", { status: 404 }))).kind, "bad-response");
  assert.equal((await kindOf(respond({ hello: "world" }, { status: 404 }))).kind, "bad-response");
});

test("a 5xx keeps the API reason when there is one", async () => {
  const e = await kindOf(respond({ error: true, reason: "Backend down" }, { status: 503 }));
  assert.equal(e.kind, "server");
  assert.equal(e.reason, "Backend down");
});

test("reason is always a bounded string (hostile payloads can't inject objects or huge text)", async () => {
  const obj = await kindOf(respond({ error: true, reason: { nested: "x" } }, { status: 400 }));
  assert.equal(obj.kind, "api-error");
  assert.equal(typeof obj.reason, "string");
  const long = await kindOf(respond({ error: true, reason: "x".repeat(5000) }, { status: 400 }));
  assert.ok(long.reason.length <= 500);
});

test("ApiError: name, kind, message", () => {
  const e = new ApiError("network", "offline");
  assert.equal(e.name, "ApiError");
  assert.equal(e.kind, "network");
  assert.equal(e.message, "offline");
  assert.ok(e instanceof Error);
});

test("the timer is cleared after success (a finished call must not keep the process alive)", async () => {
  await fetchJson("https://example.test/x", { fetchImpl: respond({}, { status: 200 }), timeoutMs: 60_000 });
  // If the 60 s timer leaked, node:test would hang until it fired; reaching this line promptly is the assertion.
  assert.ok(true);
});
