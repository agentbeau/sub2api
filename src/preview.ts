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
  private classifierCalls = 0;
  private classifierApplied = 0;
  constructor(ctx: DurableObjectState, env: PreviewEnv) {
    super(ctx, previewEnv(env));
    this.classifierEnv = env;
  }
  override async fetchWithAccess(request: Request): Promise<Response> {
    const response = await super.fetchWithAccess(request);
    if (new URL(request.url).pathname !== "/runtime/status" || response.status !== 200) return response;
    const headers = new Headers(response.headers);
    headers.set("x-pmlabs-engine-revision", "clef-hardening-20261113");
    headers.set("x-pmlabs-container-attached", String(this.ctx.container !== undefined));
    headers.set("x-pmlabs-clef-calls", String(this.classifierCalls));
    headers.set("x-pmlabs-clef-applied", String(this.classifierApplied));
    return new Response(response.body, {status: response.status, headers});
  }
  protected override async prepareAuthenticatedInference(request: Request): Promise<Request> {
    const ai = this.classifierEnv.AI;
    if (this.classifierEnv.CLEF_ENABLED !== "true" || !ai || this.inFlight >= 2) return request;
    this.inFlight++;
    let pending = false;
    try {
      const prepared = await classifyEffort(request, {
        supported: SUPPORTED,
        reserve: () => reserveClassification(this.ctx.storage),
        decide: text => {
          this.classifierCalls++;
          const task = ai.run("@cf/cloudflare/clef-flash", clefInput(text));
          pending = true;
          return task.finally(() => { this.inFlight--; });
        },
        waitUntil: task => this.ctx.waitUntil(task),
        timeoutMs: 600,
      });
      if (prepared !== request) this.classifierApplied++;
      return prepared;
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
