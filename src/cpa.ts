import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { accessRequired, crossOriginWrite } from "./access.ts";
import { BackgroundActivity, handleBackgroundActivity, type BackgroundAction } from "./background-activity.ts";
import { publicProviderResponse } from "./branding.ts";
import { ContainerLifecycle, containerUnavailable } from "./container-lifecycle.ts";
import { methodNotAllowed, serveDashboard } from "./dashboard.ts";
import type { Env } from "./env.ts";
import { handle } from "./gateway.ts";
import { takeImport } from "./import-config.ts";
import { KeyGuard } from "./key-guard.ts";
import { ManagementWindow } from "./management-window.ts";
import { OAuthLease } from "./oauth-lease.ts";
import { handleR2Bridge, STATE_BUCKET, STATE_HOST } from "./r2-bridge.ts";
import { RealtimeLease } from "./realtime-lease.ts";
import { classify } from "./routes.ts";
import { InferenceClassifier } from "./inference-classifier.ts";
import { PoolCoordinator, type FencedLease, type PoolStorage } from "./pool-coordination.ts";
import type { ObjectStore } from "./s3.ts";

const nowSeconds = () => Math.floor(Date.now() / 1000);
const poolResourcePattern = /^[A-Za-z0-9_.:-]{1,160}$/;
const poolOwnerPattern = /^[a-f0-9]{64}:[a-f0-9]{32}$/;

interface PoolStoredObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploadedAt: number;
}

type PoolObjectWriteResult =
  | { readonly ok: true; readonly object: PoolStoredObject }
  | { readonly ok: false; readonly reason: "stale_owner" | "precondition_failed" };

interface PoolObjectFence {
  readonly resource: string;
  readonly owner: string;
  readonly epoch: number;
}

class FencedWriteRejected extends Error {}

function hasPanelReferer(request: Request, url: URL): boolean {
  const referer = request.headers.get("referer");
  if (referer === null) return false;
  try {
    const source = new URL(referer);
    return source.origin === url.origin && (source.pathname === "/provider-panel.html" || source.pathname === "/management.html");
  } catch {
    return false;
  }
}

function hasManagementCredential(request: Request): boolean {
  return /^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "")
    || (request.headers.get("x-management-key") ?? "").trim().length > 0;
}

// The native console is served at the edge. Its real management requests use
// the verified browser identity and native management authentication, without a UI gate.
export class Cpa extends DurableObject<Env> {
  private readonly pool: PoolCoordinator;
  private readonly keyGuard: KeyGuard;
  private readonly lifecycle: ContainerLifecycle | undefined;
  private readonly background: BackgroundActivity;
  private readonly management: ManagementWindow;
  protected readonly inferenceClassifier: InferenceClassifier;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.pool = new PoolCoordinator(ctx.storage as unknown as PoolStorage);
    const ownerId = this.ctx.id.toString();
    const lease = new OAuthLease(ctx.storage, Date.now, async state => {
      const bound = await this.poolStub().bindPoolOAuthOwner(state, ownerId, 31 * 60_000);
      if (!bound) throw new Error("OAuth callback ownership could not be persisted");
    }, async state => { await this.poolStub().releasePoolOAuthOwner(state, ownerId); });
    const realtime = new RealtimeLease(ctx.storage);
    this.background = new BackgroundActivity(ctx.storage);
    // Retain old explicit control endpoints for compatibility with an already-open
    // old tab. The direct console never opens or depends on this editing window.
    this.management = new ManagementWindow(ctx.storage);
    this.inferenceClassifier = new InferenceClassifier({
      enabled: env.CLEF_ENABLED === "true",
      ...(env.AI === undefined ? {} : { ai: env.AI }),
      storage: ctx.storage,
      waitUntil: task => ctx.waitUntil(task),
    });
    const container = ctx.container;
    this.keyGuard = new KeyGuard(env.STATE, () => container?.running ?? false);
    if (container !== undefined) {
      this.lifecycle = new ContainerLifecycle(container, {
        idleTimeout: env.CONTAINER_IDLE_TIMEOUT_MS,
        lease: {
          remainingMs: () => Math.max(lease.remainingMs(), realtime.remainingMs(), this.background.remainingMs(), this.management.remainingMs()),
          observe: async (request, response) => {
            const oauthChanged = await lease.observe(request, response);
            const realtimeChanged = await realtime.observe(request, response);
            return oauthChanged || realtimeChanged;
          },
        },
        beforeStart: async () => {
          // A confirmed process loss also loses its OAuth sessions, realtime keys and writes.
          // Clear only their inactivity holds; provider credentials and R2 data are separate.
          await this.background.clear();
          await lease.clear();
          await realtime.clear();
          await this.management.clear();
        },
        // Resolve a pending import before every cold start. A request the Rust gateway handles
        // without forwarding must neither start CPA nor load its first-boot configuration.
        environment: async () => {
          const imported = await takeImport(env.STATE);
          return {
            OBJECTSTORE_ENDPOINT: `http://${STATE_HOST}`,
            OBJECTSTORE_BUCKET: STATE_BUCKET,
            OBJECTSTORE_ACCESS_KEY: "r2-binding",
            OBJECTSTORE_SECRET_KEY: "r2-binding",
            SUB2API_ACTIVITY_ENDPOINT: `http://${STATE_HOST}/__sub2api/activity`,
            SUB2API_POOL_FENCING: this.env.POOL_FENCING_ENABLED === "true" ? "true" : "false",
            CPA_MANAGEMENT_KEY: env.MANAGEMENT_KEY ?? "",
            ...(imported === null ? {} : { CPA_IMPORT_CONFIG: imported }),
          };
        },
        // The activity endpoint must return to the Durable Object that owns this
        // container. The bridge receives the stable DO ID as RPC props; it never
        // guesses or falls back to the singleton name.
        attach: () => container.interceptOutboundHttp(STATE_HOST, this.ctx.exports.R2Bridge({
          props: { containerId: this.ctx.id.toString() },
        })),
      });
    }
    void ctx.blockConcurrencyWhile(async () => {
      // The old Container helper persisted recurring alarms. This application has no other
      // alarms; remove that schedule before restoring native idle handling after an update.
      await ctx.storage.deleteAlarm();
      // Pending OAuth, reusable realtime keys and deferred writes must survive DO eviction.
      // Read their absolute deadlines before restoring a potentially shorter native timeout.
      await lease.restore();
      await realtime.restore();
      await this.background.restore();
      await this.management.restore();
      if (container?.running) {
        try {
          await this.lifecycle?.restore();
        } catch {
          // Forwarding retries setup. Do not crash the DO or publish configuration/secrets.
          console.error({ event: "container_restore_failed" });
        }
      }
    });
  }

  override async alarm(): Promise<void> {
    // An already queued legacy delivery can race with constructor cleanup. Acknowledge it
    // without starting, polling or scheduling the container again.
    await this.ctx.storage.deleteAlarm();
  }

  async backgroundActivity(action: BackgroundAction, id: string): Promise<boolean> {
    if (!this.ctx.container?.running) return false;
    try {
      return await this.background.update(action, id);
    } finally {
      await this.lifecycle?.refreshTimeout({ detectProtocol: true });
    }
  }

  // RPC methods are called only on the named coordinator object. That object is
  // in the existing CPA namespace and never starts its attached container.
  async claimPoolRefresh(resource: string, owner: string, leaseMs: number): Promise<FencedLease | undefined> {
    return this.pool.claimRefresh(resource, owner, leaseMs);
  }

  async renewPoolRefresh(lease: FencedLease, leaseMs: number): Promise<FencedLease | undefined> {
    return this.pool.renewRefresh(lease, leaseMs);
  }

  async releasePoolRefresh(lease: FencedLease): Promise<boolean> {
    return this.pool.release(lease);
  }

  async validatePoolFence(resource: string, owner: string, epoch: number): Promise<boolean> {
    return this.pool.currentLease(resource, owner, epoch);
  }

  async writePoolObject(
    resource: string,
    owner: string,
    epoch: number,
    key: string,
    value: ArrayBuffer,
    contentType: string,
    condition: { readonly ifMatch?: string; readonly ifNoneMatch?: string },
  ): Promise<PoolObjectWriteResult> {
    if (!poolResourcePattern.test(resource) || !poolOwnerPattern.test(owner) || !Number.isSafeInteger(epoch) || epoch < 1
      || typeof key !== "string" || key.length < 1 || key.length > 1024 || !(value instanceof ArrayBuffer)
      || typeof contentType !== "string" || contentType.length > 256) throw new RangeError("Invalid fenced object write");
    const ifMatch = condition.ifMatch?.trim();
    const ifNoneMatch = condition.ifNoneMatch?.trim();
    // Auth/config writes must compare a known base version or create only if absent.
    if ((ifMatch === undefined) === (ifNoneMatch === undefined)
      || (ifMatch !== undefined && (ifMatch.length === 0 || ifMatch === "*" || ifMatch.length > 256))) {
      return { ok: false, reason: "precondition_failed" };
    }
    if (ifNoneMatch !== undefined && ifNoneMatch !== "*") return { ok: false, reason: "precondition_failed" };
    const onlyIf = new Headers();
    if (ifMatch !== undefined) onlyIf.set("if-match", ifMatch);
    if (ifNoneMatch !== undefined) onlyIf.set("if-none-match", ifNoneMatch);
    const result = await this.pool.withCurrentLease(resource, owner, epoch, async () => {
      const object = await this.env.STATE.put(key, value, {
        onlyIf,
        httpMetadata: { contentType: contentType || "application/octet-stream" },
      });
      if (object === null) return null;
      return { key: object.key, size: object.size, etag: object.etag, uploadedAt: object.uploaded.getTime() };
    });
    if (!result.ok) return result;
    return result.value === null ? { ok: false, reason: "precondition_failed" } : { ok: true, object: result.value };
  }

  async deletePoolObject(resource: string, owner: string, epoch: number, key: string): Promise<boolean> {
    if (!poolResourcePattern.test(resource) || !poolOwnerPattern.test(owner) || !Number.isSafeInteger(epoch) || epoch < 1
      || typeof key !== "string" || key.length < 1 || key.length > 1024) throw new RangeError("Invalid fenced object delete");
    const result = await this.pool.withCurrentLease(resource, owner, epoch, async () => {
      const current = await this.env.STATE.head(key);
      if (current === null) return true;
      // R2 does not support conditional DeleteObject. A zero-byte object is the
      // existing CPA delete marker (ignored by auth loading, empty config on boot).
      // Conditional PUT makes this safe if a coordinator restarts mid-request.
      const tombstone = await this.env.STATE.put(key, new ArrayBuffer(0), {
        onlyIf: new Headers({ "if-match": current.httpEtag }),
        httpMetadata: { contentType: "application/octet-stream" },
      });
      return tombstone !== null;
    });
    return result.ok && result.value;
  }

  async bindPoolOAuthOwner(state: string, owner: string, ttlMs: number): Promise<boolean> {
    return this.pool.bindOAuthOwner(state, owner, ttlMs);
  }

  async releasePoolOAuthOwner(state: string, owner: string): Promise<boolean> {
    return this.pool.unbindOAuthOwner(state, owner);
  }

  async poolOAuthOwner(state: string): Promise<string | undefined> {
    return this.pool.callbackOwner(state);
  }

  async fencedBackgroundActivity(action: BackgroundAction, id: string, resource: string): Promise<FencedLease | boolean | undefined> {
    if (!this.ctx.container?.running) return undefined;
    const coordinator = this.poolStub();
    const owner = `${this.ctx.id.toString()}:${id}`;
    const current = await this.background.leaseFor(id);
    if (action === "begin") {
      if (current !== undefined) return undefined;
      const lease = await coordinator.claimPoolRefresh(resource, owner, 90_000);
      if (lease === undefined) return undefined;
      try {
        if (!await this.background.update(action, id, lease)) {
          await coordinator.releasePoolRefresh(lease);
          return undefined;
        }
        await this.lifecycle?.refreshTimeout({ detectProtocol: true });
        return lease;
      } catch (error) {
        await coordinator.releasePoolRefresh(lease);
        throw error;
      }
    }
    if (current === undefined || current.resource !== resource || current.owner !== owner) return undefined;
    if (action === "renew") {
      const renewed = await coordinator.renewPoolRefresh(current, 90_000);
      if (renewed === undefined) {
        await this.background.update("end", id);
        await this.lifecycle?.refreshTimeout({ detectProtocol: true });
        return undefined;
      }
      if (!await this.background.update("renew", id, renewed)) {
        await coordinator.releasePoolRefresh(renewed);
        return undefined;
      }
      await this.lifecycle?.refreshTimeout({ detectProtocol: true });
      return renewed;
    }
    if (action === "end") {
      await coordinator.releasePoolRefresh(current);
      await this.background.update("end", id);
      await this.lifecycle?.refreshTimeout({ detectProtocol: true });
      return true;
    }
    return undefined;
  }

  private poolStub(): Cpa {
    return this.env.CPA.getByName("cf-pool-coordinator-v1") as unknown as Cpa;
  }

  override fetch(request: Request): Promise<Response> {
    // An ordinary fetch never inherits an Access identity from headers or cookies.
    return this.#dispatch(request, false);
  }

  // Private binding RPC used only after the public Worker checks ctx.access.aud.
  // There is no corresponding public URL, token header, or persistent auth flag.
  fetchWithAccess(request: Request): Promise<Response> {
    if (this.env.DASHBOARD_AUTH !== "cloudflare" || !this.env.ACCESS_AUD) {
      return Promise.resolve(accessRequired());
    }
    if (crossOriginWrite(request)) {
      return Promise.resolve(Response.json({ error: "Use a same-origin authenticated request." }, {
        status: 403, headers: { "cache-control": "no-store" },
      }));
    }
    return this.#dispatch(request, true);
  }

  protected prepareAuthenticatedInference(request: Request): Promise<Request> {
    return this.inferenceClassifier.prepare(request);
  }

  protected classifierStats(): { calls: number; applied: number; inFlight: number } {
    return this.inferenceClassifier.stats();
  }

  #dispatch(request: Request, accessAuthenticated: boolean): Promise<Response> {
    // These headers are reserved for container-to-R2 fencing. Never accept a
    // client-supplied fence as evidence of ownership.
    const cleanHeaders = new Headers(request.headers);
    for (const name of ["x-sub2api-resource", "x-sub2api-owner", "x-sub2api-epoch"]) cleanHeaders.delete(name);
    request = new Request(request, { headers: cleanHeaders });
    const url = new URL(request.url);
    const path = url.pathname;
    const route = classify(path);
    // Passive console model catalogs do not wake a sleeping provider. Actual model
    // requests from the console follow the same native admission as other clients.
    const passivePanelCatalog = route === "api" && (request.method === "GET" || request.method === "HEAD")
      && (path === "/v1/models" || path === "/v1beta/models") && hasPanelReferer(request, url);
    let mayStart = false;
    let classificationAllowed = false;
    return handle(
      request,
      {
        dashboardPassword: this.env.DASHBOARD_PASSWORD ?? "",
        dashboardAccess: this.env.DASHBOARD_AUTH === undefined ? undefined : accessAuthenticated,
        nowSeconds,
        apiAccess: {
          authorize: async (candidate) => {
            const decision = await this.keyGuard.authorize(candidate);
            classificationAllowed = decision === "allowed" && this.keyGuard.classificationSafe;
            mayStart = !passivePanelCatalog && (decision === "allowed" || decision === "runtime-required");
            return decision === "runtime-only" || decision === "runtime-required" ? "allowed" : decision;
          },
          invalidate: () => {
            if (path.startsWith("/v0/management/") || path.startsWith("/v8/management/")) this.keyGuard.invalidate();
          },
        },
        loginLimiter: this.env.LOGIN_LIMIT,
      },
      async (forwarded) => {
        if (path === "/management.html" || path === "/provider-panel.html") return serveDashboard(forwarded, this.env.STATE);
        if (path === "/runtime/status" || path === "/runtime/start" || path === "/runtime/stop") return publicProviderResponse(await this.controls(forwarded));
        if (route === "ready") {
          if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
          return publicProviderResponse(await (this.lifecycle?.forward(forwarded) ?? containerUnavailable()));
        }
        // This callback is reached only after browser authentication.
        // Let the native server validate management credentials instead of duplicating
        // its authentication at the edge. An invalid management key can therefore wake
        // the server; missing credentials, status polls and stale callbacks cannot.
        const nativeManagement = route === "dashboard"
          && (path.startsWith("/v0/management/") || path.startsWith("/v8/management/"))
          && hasManagementCredential(forwarded);
        if (route === "api" && classificationAllowed && this.keyGuard.classificationSafe) {
          forwarded = await this.prepareAuthenticatedInference(forwarded);
        }
        const options = { requireFrontendAuth: route === "api" };
        const upstreamPath = new URL(forwarded.url).pathname;
        const providerCallback = route === "oauth-callback" || upstreamPath === "/v0/management/oauth-callback"
          || upstreamPath === "/v8/management/oauth/callback";
        const shouldFence = this.env.POOL_FENCING_ENABLED === "true"
          && ((nativeManagement && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) || providerCallback);
        let fencedRequest = forwarded;
        let fence: FencedLease | undefined;
        if (shouldFence) {
          const operation = providerCallback ? "oauth-callback" : "management-write";
          const activityId = crypto.randomUUID().replaceAll("-", "").toLowerCase();
          const owner = `${this.ctx.id.toString()}:${activityId}`;
          fence = await this.poolStub().claimPoolRefresh(operation, owner, 90_000);
          if (fence === undefined) return new Response(null, { status: 409, headers: { "cache-control": "no-store" } });
          const headers = new Headers(forwarded.headers);
          headers.set("x-sub2api-resource", fence.resource);
          headers.set("x-sub2api-owner", fence.owner);
          headers.set("x-sub2api-epoch", String(fence.epoch));
          fencedRequest = new Request(forwarded, { headers });
        }
        let response: Response;
        try {
          response = await (((route === "api" && mayStart) || nativeManagement ? this.lifecycle?.forward(fencedRequest, options) : this.lifecycle?.forwardExisting(fencedRequest, options))
            ?? containerUnavailable());
        } finally {
          if (fence !== undefined) await this.poolStub().releasePoolRefresh(fence);
        }
        return publicProviderResponse(response, route === "api");
      },
    );
  }

  private async controls(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const status = url.pathname === "/runtime/status";
    if (status ? request.method !== "GET" && request.method !== "HEAD" : request.method !== "POST") {
      return methodNotAllowed(status ? "GET, HEAD" : "POST");
    }
    if (!status && request.headers.get("origin") !== url.origin) {
      return Response.json({ error: { message: "Use a same-origin authenticated request." } }, {
        status: 403, headers: { "cache-control": "no-store" },
      });
    }
    try {
      if (url.pathname === "/runtime/start") {
        if (this.lifecycle === undefined) return containerUnavailable();
        const response = await this.lifecycle.forward(new Request(new URL("/healthz", url), { signal: request.signal }));
        if (!response.ok) return response;
        void response.body?.cancel().catch(() => {});
        if (!this.ctx.container?.running) return containerUnavailable();
        // Grant only after a successful native start. beforeStart has already
        // cleared the departed process's holds, and this request is still active.
        await this.management.open();
      } else if (url.pathname === "/runtime/stop") {
        // This releases only the explicit editing hold; never stop active work.
        await this.management.clear();
      }
      await this.lifecycle?.refreshTimeout({ detectProtocol: true });
      const running = this.ctx.container?.running ?? false;
      const body = { running, controls_remaining_ms: running ? this.management.remainingMs() : 0 };
      return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch {
      return containerUnavailable();
    }
  }
}

// The only intercepted egress is CPA's internal HTTP object store. Provider HTTPS connections
// leave the Linux container directly, preserving CPA's transport and TLS behavior.
export class R2Bridge extends WorkerEntrypoint<Env, { containerId: string }> {
  private fencedStore(request: Request, fence: PoolObjectFence): ObjectStore {
    const coordinator = this.env.CPA.getByName("cf-pool-coordinator-v1");
    return {
      head: key => this.env.STATE.head(key),
      get: key => this.env.STATE.get(key),
      list: options => this.env.STATE.list(options),
      put: async (key, value, options) => {
        const condition = {
          ...(options?.onlyIf?.get("if-match") === null || options?.onlyIf?.get("if-match") === undefined
            ? {} : { ifMatch: options.onlyIf.get("if-match") as string }),
          ...(options?.onlyIf?.get("if-none-match") === null || options?.onlyIf?.get("if-none-match") === undefined
            ? {} : { ifNoneMatch: options.onlyIf.get("if-none-match") as string }),
        };
        const result = await coordinator.writePoolObject(
          fence.resource,
          fence.owner,
          fence.epoch,
          key,
          value,
          request.headers.get("content-type") ?? "application/octet-stream",
          condition,
        );
        if (!result.ok && result.reason === "stale_owner") throw new FencedWriteRejected("stale object-store write");
        if (!result.ok) return null;
        const stored = result.object;
        return { key: stored.key, size: stored.size, etag: stored.etag, uploaded: new Date(stored.uploadedAt) };
      },
      delete: async key => {
        const deleted = await coordinator.deletePoolObject(fence.resource, fence.owner, fence.epoch, key);
        if (!deleted) throw new FencedWriteRejected("stale object-store delete");
      },
    };
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/__sub2api/activity") {
      const containerId = this.ctx.props?.containerId;
      if (typeof containerId !== "string" || !/^[a-f0-9]{64}$/.test(containerId)) {
        return Promise.resolve(new Response(null, { status: 404, headers: { "cache-control": "no-store" } }));
      }
      try {
        const owner = this.env.CPA.get(this.env.CPA.idFromString(containerId));
        return handleBackgroundActivity(request, (action, id, resource) => resource === undefined
          ? owner.backgroundActivity(action, id)
          : owner.fencedBackgroundActivity(action, id, resource));
      } catch {
        return Promise.resolve(new Response(null, { status: 404, headers: { "cache-control": "no-store" } }));
      }
    }
    let store: ObjectStore = this.env.STATE;
    let fence: PoolObjectFence | undefined;
    if (this.env.POOL_FENCING_ENABLED === "true" && ["PUT", "DELETE"].includes(request.method)) {
      const url = new URL(request.url);
      if (url.pathname.split("/").filter(Boolean).length > 1) {
        const resource = request.headers.get("x-sub2api-resource") ?? "";
        const owner = request.headers.get("x-sub2api-owner") ?? "";
        const epochText = request.headers.get("x-sub2api-epoch") ?? "";
        const epoch = Number(epochText);
        if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(resource) || !/^[a-f0-9]{64}:[a-f0-9]{32}$/.test(owner)
          || !/^\d+$/.test(epochText) || !Number.isSafeInteger(epoch) || epoch < 1) {
          return new Response(null, { status: 409, headers: { "cache-control": "no-store" } });
        }
        const containerId = this.ctx.props?.containerId;
        if (typeof containerId !== "string" || !/^[a-f0-9]{64}$/.test(containerId) || !owner.startsWith(`${containerId}:`)) {
          return new Response(null, { status: 409, headers: { "cache-control": "no-store" } });
        }
        const ifMatch = request.headers.get("if-match");
        const ifNoneMatch = request.headers.get("if-none-match");
        if (request.method === "PUT" && ((ifMatch === null) === (ifNoneMatch === null)
          || (ifNoneMatch !== null && ifNoneMatch !== "*"))) {
          return new Response(null, { status: 428, headers: { "cache-control": "no-store" } });
        }
        fence = { resource, owner, epoch };
        store = this.fencedStore(request, fence);
      }
    }
    try {
      return await handleR2Bridge(request, store);
    } catch (error) {
      if (error instanceof FencedWriteRejected) return new Response(null, { status: 409, headers: { "cache-control": "no-store" } });
      throw error;
    }
  }
}
