import { classifyEffort, clefInput, type Effort } from "./effort-classifier.ts";
import { reserveClassification } from "./classifier-budget.ts";

const SUPPORTED: Readonly<Record<string, readonly Effort[]>> = Object.fromEntries(
  ["gpt-6-luna", "gpt-6-astra", "gpt-6.1-terra", "gpt-6.1-sol"].map(id => [id, ["low", "medium", "high"] as const]),
);

export interface ClassifierAI {
  run(model: string, input: ReturnType<typeof clefInput>): Promise<unknown>;
}

export interface ClassifierStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  transaction<T>(callback: (txn: Pick<ClassifierStorage, "get" | "put">) => Promise<T>): Promise<T>;
}

export interface InferenceClassifierOptions {
  readonly enabled: boolean;
  readonly ai?: ClassifierAI;
  readonly storage: ClassifierStorage;
  readonly waitUntil: (task: Promise<unknown>) => void;
}

// The classifier sees only bounded last-user text and can only add a supported
// effort field. Explicit effort and all unsupported/malformed requests bypass it.
export class InferenceClassifier {
  private inFlight = 0;
  private calls = 0;
  private applied = 0;

  constructor(private readonly options: InferenceClassifierOptions) {}

  async prepare(request: Request): Promise<Request> {
    const { enabled, ai } = this.options;
    if (!enabled || !ai || this.inFlight >= 2) return request;
    this.inFlight++;
    let taskOwnsSlot = false;
    try {
      const prepared = await classifyEffort(request, {
        supported: SUPPORTED,
        reserve: () => reserveClassification(this.options.storage),
        decide: text => {
          this.calls++;
          const task = ai.run("@cf/cloudflare/clef-flash", clefInput(text));
          taskOwnsSlot = true;
          return task.finally(() => { this.inFlight--; });
        },
        waitUntil: this.options.waitUntil,
        timeoutMs: 600,
      });
      if (prepared !== request) this.applied++;
      return prepared;
    } finally {
      if (!taskOwnsSlot) this.inFlight--;
    }
  }

  stats(): { calls: number; applied: number; inFlight: number } {
    return { calls: this.calls, applied: this.applied, inFlight: this.inFlight };
  }
}
