// Separate preview entrypoint: every route, including health/API, is owner-gated.
import gateway from "./index.ts";
import { previewAllowed } from "./preview-access.ts";
import type { Env } from "./env.ts";
import { Cpa, R2Bridge as BaseR2Bridge } from "./cpa.ts";

type PreviewEnv = Omit<Env, "CPA"> & {
  readonly ENGINE: Env["CPA"];
  readonly PREVIEW_ACCESS_AUD?: string;
  readonly PREVIEW_SOURCE_REVISION?: string;
  readonly AI?: Env["AI"];
  readonly CLEF_ENABLED?: string;
};
// Every exported entrypoint receives the same preview binding adapter.
function previewEnv(env: PreviewEnv): Env {
  return { ...env, CPA: env.ENGINE };
}
export class Engine extends Cpa {
  private readonly classifierEnv: PreviewEnv;
  constructor(ctx: DurableObjectState, env: PreviewEnv) {
    super(ctx, previewEnv(env));
    this.classifierEnv = env;
  }
  override async fetchWithAccess(request: Request): Promise<Response> {
    const response = await super.fetchWithAccess(request);
    if (new URL(request.url).pathname !== "/runtime/status" || response.status !== 200) return response;
    const headers = new Headers(response.headers);
    const revision = this.classifierEnv.PREVIEW_SOURCE_REVISION;
    headers.set("x-pmlabs-engine-revision", revision && /^[a-f0-9]{40}$/.test(revision) ? revision : "unversioned");
    headers.set("x-pmlabs-container-attached", String(this.ctx.container !== undefined));
    const stats = this.classifierStats();
    headers.set("x-pmlabs-clef-calls", String(stats.calls));
    headers.set("x-pmlabs-clef-applied", String(stats.applied));
    return new Response(response.body, {status: response.status, headers});
  }
}
export class R2Bridge extends BaseR2Bridge {
  constructor(ctx: ExecutionContext, env: PreviewEnv) {
    super(ctx, previewEnv(env));
  }
}
export default {
  fetch(request: Request, env: PreviewEnv, ctx: ExecutionContext & { access?: { aud?: string } }): Response | Promise<Response> {
    if (!previewAllowed(env.PREVIEW_ACCESS_AUD, ctx.access)) {
      return new Response("Private preview. Owner sign-in is required.", {
        status: 403, headers: { "cache-control": "no-store" },
      });
    }
    return gateway.fetch(request, previewEnv(env), ctx);
  },
};
