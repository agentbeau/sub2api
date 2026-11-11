import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { BackgroundActivity, handleBackgroundActivity, type BackgroundAction } from "./background-activity.ts";
import { ContainerLifecycle, containerUnavailable } from "./container-lifecycle.ts";
import type { Env } from "./env.ts";
import { handle } from "./gateway.ts";
import { takeImport } from "./import-config.ts";
import { KeyGuard } from "./key-guard.ts";
import { OAuthLease } from "./oauth-lease.ts";
import { handleR2Bridge, STATE_BUCKET, STATE_HOST } from "./r2-bridge.ts";

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Provider and dashboard requests share this Durable Object, so one KeyGuard sees every
// dashboard change no matter which Worker isolate took the request.
export class Cpa extends DurableObject<Env> {
  private readonly keyGuard = new KeyGuard(nowSeconds);
  private readonly lifecycle: ContainerLifecycle | undefined;
  private readonly background: BackgroundActivity;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const lease = new OAuthLease(ctx.storage);
    this.background = new BackgroundActivity(ctx.storage);
    const container = ctx.container;
    if (container !== undefined) {
      this.lifecycle = new ContainerLifecycle(container, {
        idleTimeout: env.CONTAINER_IDLE_TIMEOUT_MS,
        lease: {
          remainingMs: () => Math.max(lease.remainingMs(), this.background.remainingMs()),
          observe: (request, response) => lease.observe(request, response),
        },
        beforeStart: async () => {
          // A confirmed process loss also loses its pending OAuth sessions and local writes.
          // Clear only their inactivity holds; provider credentials and R2 data are separate.
          await this.background.clear();
          await lease.clear();
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
      // Pending OAuth sessions and deferred object-store writes must survive DO eviction.
      // Read their absolute deadlines before restoring a potentially shorter native timeout.
      await lease.restore();
      await this.background.restore();
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
    return handle(
      request,
      {
        dashboardPassword: this.env.DASHBOARD_PASSWORD ?? "",
        nowSeconds,
        keyGuard: this.keyGuard,
        loginLimiter: this.env.LOGIN_LIMIT,
      },
      (forwarded) => this.lifecycle?.forward(forwarded) ?? Promise.resolve(containerUnavailable()),
    );
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
