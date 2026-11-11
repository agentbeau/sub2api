import { createServer } from "node:http";
import { clearTimeout, setTimeout } from "node:timers";
import { BackgroundActivity, handleBackgroundActivity } from "../src/background-activity.ts";
import { handleS3 } from "../src/s3.ts";
import { LeaseStorage } from "./lease-storage.ts";
import { MemoryStore } from "./memory-store.ts";

const store = new MemoryStore();
const port = Number(process.env.PORT ?? "9000");
const leaseStorage = new LeaseStorage();
const activity = new BackgroundActivity(leaseStorage);
const counts = { begin: 0, renew: 0, end: 0, rejected: 0 };
let delayArmed = false;
let releaseWrite: (() => void) | undefined;
const delayed = { pending: false, started: 0, completed: 0, protected: true, elapsedMs: 0, timedOut: false };

// These controls exist only in the local smoke fixture. They hold a real S3 PUT
// while the same BackgroundActivity controller used by the Worker tracks leases.
function recordProtection(): void {
  if (delayed.pending && activity.remainingMs() <= 0) delayed.protected = false;
}

createServer(async (incoming, outgoing) => {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const method = incoming.method ?? "GET";
  if (incoming.url === "/__activity" && method === "GET") {
    recordProtection();
    const saved = await leaseStorage.get<{ jobs: Array<[string, { until: number }]> }>("sub2api:background-activity:v1");
    const active = saved?.jobs.filter(([, job]) => job.until > Date.now()).length ?? 0;
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ ...counts, active, remainingMs: activity.remainingMs(), delayed }));
    return;
  }
  if (incoming.url === "/__delay-config-put" && method === "POST") {
    if (delayArmed || delayed.pending) {
      outgoing.writeHead(409).end();
      return;
    }
    delayArmed = true;
    outgoing.writeHead(204).end();
    return;
  }
  if (incoming.url === "/__release-config-put" && method === "POST") {
    if (!releaseWrite) {
      outgoing.writeHead(409).end();
      return;
    }
    releaseWrite();
    outgoing.writeHead(204).end();
    return;
  }
  if (incoming.url === "/__keys") {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify([...store.entries.keys()].sort()));
    return;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  const hasBody = method !== "GET" && method !== "HEAD";
  const isActivity = incoming.url === "/__sub2api/activity";
  // The Docker fixture uses its local network hostname. Normalize only this
  // private protocol path, including Host, before the production validator.
  if (isActivity) headers.set("host", "r2.internal");
  const host = isActivity ? "r2.internal" : incoming.headers.host ?? "localhost";
  const request = new Request(`http://${host}${incoming.url ?? "/"}`, {
    method,
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  });
  if (isActivity) {
    const response = await handleBackgroundActivity(request, async (action, id) => {
      const accepted = await activity.update(action, id);
      if (accepted) counts[action] += 1;
      else counts.rejected += 1;
      recordProtection();
      return accepted;
    });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end();
    return;
  }
  let heldWrite = false;
  const delayStartedAt = Date.now();
  if (delayArmed && method === "PUT" && new URL(request.url).pathname === "/state/config/config.yaml") {
    delayArmed = false;
    heldWrite = true;
    delayed.pending = true;
    delayed.started += 1;
    recordProtection();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        delayed.timedOut = true;
        releaseWrite = undefined;
        resolve();
      }, 20_000);
      releaseWrite = () => {
        clearTimeout(timeout);
        releaseWrite = undefined;
        resolve();
      };
    });
    recordProtection();
  }
  const response = await handleS3(request, store, "state");
  if (heldWrite) {
    recordProtection();
    delayed.pending = false;
    delayed.completed += 1;
    delayed.elapsedMs = Date.now() - delayStartedAt;
  }
  console.log(method, incoming.url, response.status);
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`s3 test server on ${port}`));
