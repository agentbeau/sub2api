// Separate preview entrypoint: every route, including health/API, is owner-gated.
import gateway from "./index.ts";
import { previewAllowed } from "./preview-access.ts";
import type { Env } from "./env.ts";
import { Cpa, R2Bridge as BaseR2Bridge } from "./cpa.ts";

type PreviewEnv = Omit<Env, "CPA"> & { readonly ENGINE: Env["CPA"]; readonly PREVIEW_ACCESS_AUD?: string };
// Every exported entrypoint receives the same preview binding adapter.
function previewEnv(env: PreviewEnv): Env {
  return { ...env, CPA: env.ENGINE };
}
export class Engine extends Cpa {
  constructor(ctx: DurableObjectState, env: PreviewEnv) {
    super(ctx, previewEnv(env));
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
