import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
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

const nowSeconds = () => Math.floor(Date.now() / 1000);

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
// the existing session and native management authentication, without a UI gate.
export class Cpa extends DurableObject<Env> {
  private readonly keyGuard: KeyGuard;
  private readonly lifecycle: ContainerLifecycle | undefined;
  private readonly background: BackgroundActivity;
  private readonly management: ManagementWindow;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const lease = new OAuthLease(ctx.storage);
    const realtime = new RealtimeLease(ctx.storage);
    this.background = new BackgroundActivity(ctx.storage);
    // Retain old explicit control endpoints for compatibility with an already-open
    // old tab. The direct console never opens or depends on this editing window.
    this.management = new ManagementWindow(ctx.storage);
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
            CPA_MANAGEMENT_KEY: env.MANAGEMENT_KEY ?? "",
            ...(imported === null ? {} : { CPA_IMPORT_CONFIG: imported }),
          };
        },
        attach: () => container.interceptOutboundHttp(STATE_HOST, this.ctx.exports.R2Bridge),
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

  override fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const route = classify(path);
    // Passive console model catalogs do not wake a sleeping provider. Actual model
    // requests from the console follow the same native admission as other clients.
    const passivePanelCatalog = route === "api" && (request.method === "GET" || request.method === "HEAD")
      && (path === "/v1/models" || path === "/v1beta/models") && hasPanelReferer(request, url);
    let mayStart = false;
    return handle(
      request,
      {
        dashboardPassword: this.env.DASHBOARD_PASSWORD ?? "",
        nowSeconds,
        apiAccess: {
          authorize: async (candidate) => {
            const decision = await this.keyGuard.authorize(candidate);
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
        // This callback is reached only after the existing dashboard session gate.
        // Let the native server validate management credentials instead of duplicating
        // its authentication at the edge. An invalid management key can therefore wake
        // the server; missing credentials, status polls and stale callbacks cannot.
        const nativeManagement = route === "dashboard"
          && (path.startsWith("/v0/management/") || path.startsWith("/v8/management/"))
          && hasManagementCredential(forwarded);
        const options = { requireFrontendAuth: route === "api" };
        const response = await (((route === "api" && mayStart) || nativeManagement ? this.lifecycle?.forward(forwarded, options) : this.lifecycle?.forwardExisting(forwarded, options))
          ?? containerUnavailable());
        return publicProviderResponse(response);
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
export class R2Bridge extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/__sub2api/activity") {
      return handleBackgroundActivity(request, (action, id) => this.env.CPA.getByName("cf-singleton-container").backgroundActivity(action, id));
    }
    return handleR2Bridge(request, this.env.STATE);
  }
}
