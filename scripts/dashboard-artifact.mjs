import { createHash } from "node:crypto";

export async function verifyExistingDashboard({ account, bucket, token, fetcher = fetch }) {
  if (!/^[a-f0-9]{32}$/.test(account ?? "") || !/^[a-z0-9-]+$/.test(bucket ?? "") || !token) {
    throw new Error("Cloudflare account, existing state bucket, and access token are required to preserve the dashboard");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects/dashboard/management.html`;
  const response = await fetcher(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Could not verify the existing dashboard artifact (HTTP ${response.status}); no dashboard changes attempted`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("The existing dashboard artifact is empty; no dashboard changes attempted");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { byteLength: bytes.byteLength, sha256 };
}
