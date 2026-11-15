import { WorkerEntrypoint } from "cloudflare:workers";
import gateway from "./index.ts";
import { Cpa } from "./cpa.ts";
import { handleBackgroundActivity } from "./background-activity.ts";
import { handleR2Bridge } from "./r2-bridge.ts";
import { previewAllowed } from "./preview-access.ts";
import { schedulerOptions, SCHEDULER_SINGLETON } from "./scheduler-options.ts";
import type { ContainerImageOptions } from "./container-lifecycle.ts";
import type { Env } from "./env.ts";

type SchedulerEnv = Omit<Env, "CPA"> & {
  readonly ENGINE: Env["CPA"];
  readonly PREVIEW_ACCESS_AUD?: string;
};

export class ScheduledEngine extends Cpa {
  constructor(ctx: DurableObjectState, env: SchedulerEnv) {
    super(ctx, { ...env, CPA: env.ENGINE });
  }

  protected override containerStartup(): ContainerImageOptions {
    return schedulerOptions(this.ctx.id.equals(this.env.CPA.idFromName(SCHEDULER_SINGLETON)), this.ctx.container?.images ?? {});
  }
}

// This export name matches the lifecycle's private interception entrypoint.
// ENGINE is mapped explicitly; no production binding is present in this Worker.
export class R2Bridge extends WorkerEntrypoint<SchedulerEnv> {
  override fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/__sub2api/activity") {
      return handleBackgroundActivity(request, (action, id) => this.env.ENGINE.getByName(SCHEDULER_SINGLETON).backgroundActivity(action, id));
    }
    return handleR2Bridge(request, this.env.STATE);
  }
}

export default {
  fetch(request: Request, env: SchedulerEnv, ctx: ExecutionContext & { access?: { aud?: string } }): Response | Promise<Response> {
    if (!previewAllowed(env.PREVIEW_ACCESS_AUD, ctx.access)) {
      return new Response("Private scheduler lab. Owner sign-in is required.", {
        status: 403, headers: { "cache-control": "no-store" },
      });
    }
    return gateway.fetch(request, { ...env, CPA: env.ENGINE }, ctx);
  },
};
