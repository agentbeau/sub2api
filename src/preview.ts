// Separate preview entrypoint: every route, including health/API, is owner-gated.
import gateway from "./index.ts";
import { previewAllowed } from "./preview-access.ts";
import type { Env } from "./env.ts";
export { Cpa as Engine, R2Bridge } from "./cpa.ts";

type PreviewEnv = Omit<Env, "CPA"> & { readonly ENGINE: Env["CPA"]; readonly PREVIEW_ACCESS_AUD?: string };
export default {
  fetch(request: Request, env: PreviewEnv, ctx: ExecutionContext & { access?: { aud?: string } }): Response | Promise<Response> {
    if (!previewAllowed(env.PREVIEW_ACCESS_AUD, ctx.access)) {
      return new Response("Private preview. Owner sign-in is required.", {
        status: 403, headers: { "cache-control": "no-store" },
      });
    }
    return gateway.fetch(request, { ...env, CPA: env.ENGINE }, ctx);
  },
};
