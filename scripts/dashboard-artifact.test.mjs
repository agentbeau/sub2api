import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import test from "node:test";
import { verifyExistingDashboard } from "./dashboard-artifact.mjs";

const account = "a".repeat(32);
const token = "test-only-token";
const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/gateway-preview-state/objects/dashboard/management.html`;

test("the existing dashboard is fetched as exact bytes and only its digest is returned", async () => {
  const bytes = Buffer.from("<html>existing enhanced panel</html>");
  let request;
  const result = await verifyExistingDashboard({
    account, bucket: "gateway-preview-state", token,
    fetcher: async (actualUrl, options) => {
      request = { actualUrl, options };
      return new Response(bytes, { headers: { "content-type": "text/html" } });
    },
  });
  assert.equal(request.actualUrl, url);
  assert.equal(request.options.headers.authorization, `Bearer ${token}`);
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
});

test("missing, empty, or unreadable dashboards fail closed", async () => {
  for (const [response, pattern] of [
    [new Response(null, { status: 404 }), /HTTP 404/],
    [new Response(null, { status: 503 }), /HTTP 503/],
    [new Response(new Uint8Array()), /is empty/],
  ]) {
    await assert.rejects(verifyExistingDashboard({ account, bucket: "sub2api", token, fetcher: async () => response }), pattern);
  }
});

test("dashboard preservation requires an exact account, bucket and scoped token", async () => {
  for (const input of [
    { account: "bad", bucket: "sub2api", token },
    { account, bucket: "../sub2api", token },
    { account, bucket: "sub2api", token: "" },
  ]) {
    await assert.rejects(verifyExistingDashboard({ ...input, fetcher: async () => { throw new Error("should not fetch"); } }));
  }
});
