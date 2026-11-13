// Separate preview entrypoint: every route, including health/API, is owner-gated.
import { classifyEffort, clefInput, type Effort } from "./effort-classifier.ts";
import { reserveClassification } from "./classifier-budget.ts";
import gateway from "./index.ts";
import { previewAllowed } from "./preview-access.ts";
import type { Env } from "./env.ts";
import { Cpa, R2Bridge as BaseR2Bridge } from "./cpa.ts";

// Capabilities pinned to engine v8.0.67 models/models.json, not guessed aliases.
const SUPPORTED: Readonly<Record<string, readonly Effort[]>> = Object.fromEntries(
  ["gpt-6-luna", "gpt-6-astra", "gpt-6.1-terra", "gpt-6.1-sol"].map(id => [id, ["low", "medium", "high"] as const]),
);
interface ClassifierAI { run(model: string, input: ReturnType<typeof clefInput>): Promise<unknown> }
type PreviewEnv = Omit<Env, "CPA"> & { readonly ENGINE: Env["CPA"]; readonly PREVIEW_ACCESS_AUD?: string; readonly AI?: ClassifierAI; readonly CLEF_ENABLED?: string };
// Every exported entrypoint receives the same preview binding adapter.
function previewEnv(env: PreviewEnv): Env {
  return { ...env, CPA: env.ENGINE };
}
export class Engine extends Cpa {
  private readonly classifierEnv: PreviewEnv;
  private inFlight = 0;
  constructor(ctx: DurableObjectState, env: PreviewEnv) {
    super(ctx, previewEnv(env));
    this.classifierEnv = env;
  }
  protected override async prepareAuthenticatedInference(request: Request): Promise<Request> {
    const ai = this.classifierEnv.AI;
    if (this.classifierEnv.CLEF_ENABLED !== "true" || !ai || this.inFlight >= 2) return request;
    this.inFlight++;
    let pending = false;
    try {
      return await classifyEffort(request, {
        supported: SUPPORTED,
        reserve: () => reserveClassification(this.ctx.storage),
        decide: text => {
          const task = ai.run("@cf/cloudflare/clef-flash", clefInput(text));
          pending = true;
          return task.finally(() => { this.inFlight--; });
        },
        waitUntil: task => this.ctx.waitUntil(task),
        timeoutMs: 600,
      });
    } finally { if (!pending) this.inFlight--; }
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
