import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyGuard, type AccessStore } from "../src/key-guard.ts";

const CONFIG = "config/config.yaml";
const IMPORT = "import/config.yaml";
const CONFIGURED = "config-version: 8\naccess:\n  api-keys: [client-alpha]\n";

class MemoryAccessStore implements AccessStore {
  readonly objects = new Map<string, string>();
  readonly reads: string[] = [];
  failure: "get" | "text" | undefined;

  constructor(config: string | null = CONFIGURED) {
    if (config !== null) this.objects.set(CONFIG, config);
  }

  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    this.reads.push(key);
    if (this.failure === "get") throw new Error("R2 unavailable");
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return { text: async () => {
      if (this.failure === "text") throw new Error("R2 body unavailable");
      return value;
    } };
  }
}

function request(headers: HeadersInit = {}, path = "/v1/models", method = "GET"): Request {
  return new Request(`https://gateway.example${path}`, { method, headers });
}

function setup(config: string | null = CONFIGURED, running = false) {
  const store = new MemoryAccessStore(config);
  const runtime = { running };
  return { store, runtime, guard: new KeyGuard(store, () => runtime.running) };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("R2 client-key admission", () => {
  it("rejects missing and invalid ordinary keys without issuing a provider request", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not probe CPA"));
    const { guard } = setup();
    expect(await guard.authorize(request())).toBe("denied");
    expect(await guard.authorize(request({ authorization: "Bearer wrong" }))).toBe("denied");
    expect(outbound).not.toHaveBeenCalled();
  });

  it("admits the actual valid request without consuming its body", async () => {
    const { guard } = setup();
    const inference = new Request("https://gateway.example/v1/messages", {
      method: "POST", headers: { "x-api-key": "client-alpha" }, body: "unread inference body",
    });
    expect(await guard.authorize(inference)).toBe("allowed");
    expect(inference.bodyUsed).toBe(false);
    expect(await inference.text()).toBe("unread inference body");
  });

  it("honors additions and revocations on the next call without an invalidation or cache window", async () => {
    const { guard, store } = setup("access: {api-keys: []}");
    const alpha = request({ "x-api-key": "client-alpha" });
    expect(await guard.authorize(alpha)).toBe("unconfigured");
    store.objects.set(CONFIG, CONFIGURED);
    expect(await guard.authorize(alpha)).toBe("allowed");
    store.objects.set(CONFIG, "access: {api-keys: [client-beta]}");
    expect(await guard.authorize(alpha)).toBe("denied");
    expect(await guard.authorize(request({ "x-api-key": "client-beta" }))).toBe("allowed");
    expect(store.reads).toEqual([CONFIG, CONFIG, CONFIG, CONFIG]);
  });

  it("reads a waiting import only when canonical config is absent", async () => {
    const { guard, store } = setup(null);
    store.objects.set(IMPORT, "access: {api-keys: [import-key]}");
    expect(await guard.authorize(request({ "x-api-key": "import-key" }))).toBe("allowed");
    expect(store.reads).toEqual([CONFIG, IMPORT]);
    store.objects.set(CONFIG, CONFIGURED);
    expect(await guard.authorize(request({ "x-api-key": "import-key" }))).toBe("denied");
    expect(store.reads).toEqual([CONFIG, IMPORT, CONFIG]);
  });

  it("uses the effective imported body after entrypoint-owned settings are removed", async () => {
    const { guard, store } = setup(null);
    store.objects.set(IMPORT, "config-version: 7\nserver: invalid\naccess: {api-keys: [import-key]}");
    expect(await guard.authorize(request({ "x-api-key": "import-key" }))).toBe("allowed");
  });

  it("keeps a new installation unconfigured without starting it", async () => {
    const { guard } = setup(null);
    expect(await guard.authorize(request({ "x-api-key": "anything" }))).toBe("unconfigured");
  });

  it.each(["get", "text"] as const)("fails closed on R2 %s errors without using a stale key or import", async (failure) => {
    const { guard, store } = setup();
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }))).toBe("allowed");
    store.objects.set(IMPORT, CONFIGURED);
    store.failure = failure;
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }))).toBe("unavailable");
    expect(store.reads).toEqual([CONFIG, CONFIG]);
  });

  it.each([
    ["legacy list", "api-keys: [client-alpha]", "allowed"],
    ["v8 value wins", "api-keys: [wrong]\naccess: {api-keys: [client-alpha]}", "allowed"],
    ["v8 empty list clears legacy", "api-keys: [client-alpha]\naccess: {api-keys: []}", "unconfigured"],
    ["v8 null clears legacy", "api-keys: [client-alpha]\naccess: {api-keys: null}", "unconfigured"],
    ["missing v8 key preserves legacy", "api-keys: [client-alpha]\naccess: {}", "allowed"],
    ["root upstream mapping is not a client key list", "api-keys: {codex: [{keys: [{api-key: client-alpha}]}]}", "unconfigured"],
    ["empty keys are discarded", 'access: {api-keys: ["", "   "]}', "unconfigured"],
    ["keys are trimmed and deduplicated", 'access: {api-keys: [" client-alpha ", client-alpha]}', "allowed"],
  ])("%s", async (_label, config, expected) => {
    const { guard } = setup(config);
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }))).toBe(expected);
  });

  it("resolves YAML aliases and merge keys before applying v8 precedence", async () => {
    const { guard } = setup(`keys: &keys [client-alpha]
defaults: &defaults
  access: {api-keys: *keys}
<<: *defaults
api-keys: [wrong]
`);
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }))).toBe("allowed");
  });

  it("lets explicit empty access override a merged access setting", async () => {
    const { guard } = setup(`defaults: &defaults {access: {api-keys: [client-alpha]}}
<<: *defaults
access: {api-keys: []}
`);
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }))).toBe("unconfigured");
  });

  it.each([
    "", "[]", "access: [", "access: null", "access: false", "access: {api-keys: wrong}",
    "access: {api-keys: [client-alpha, {}]}", "config-version: 7\naccess: {api-keys: [client-alpha]}",
    'config-version: "8"\naccess: {api-keys: [client-alpha]}',
    "api-keys: [client-alpha]\napi-keys: [wrong]", "access: {api-keys: [client-alpha], api-keys: [wrong]}",
    "other: {duplicate: a, duplicate: b}\naccess: {api-keys: [client-alpha]}",
    "cycle: &cycle {self: *cycle}\naccess: {api-keys: [client-alpha]}",
    "access: {api-keys: *missing}", "access: {api-keys: [client-alpha]}\n---\naccess: {}",
  ])("rejects malformed/ambiguous YAML before authorization: %s", async (config) => {
    const { guard } = setup(config);
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }))).toBe("unavailable");
  });

  it.each([
    [{ authorization: "Bearer client-alpha" }, "/v1/models", "allowed"],
    [{ authorization: "bEaReR   client-alpha" }, "/v1/models", "allowed"],
    [{ authorization: "client-alpha" }, "/v1/models", "allowed"],
    [{ authorization: "Bearer\tclient-alpha" }, "/v1/models", "denied"],
    [{ authorization: "Basic client-alpha" }, "/v1/models", "denied"],
    [{ "x-goog-api-key": "client-alpha" }, "/v1/models", "allowed"],
    [{ "x-api-key": "client-alpha" }, "/v1/models", "allowed"],
    [{ authorization: "Bearer wrong", "x-goog-api-key": "client-alpha" }, "/v1/models", "allowed"],
    [{ authorization: "wrong", "x-goog-api-key": "wrong", "x-api-key": "client-alpha" }, "/v1/models", "allowed"],
    [{ "x-api-key": "wrong" }, "/v1/models?key=client-alpha", "allowed"],
    [{}, "/v1/models?key=wrong&auth_token=client-alpha", "allowed"],
    [{}, "/v1/models?key=wrong&key=client-alpha", "denied"],
    [{}, "/v1/models?KEY=client-alpha", "denied"],
    [{}, "/v1/models?key=%20client-alpha%20", "denied"],
    [{ "x-api-key": "CLIENT-ALPHA" }, "/v1/models", "denied"],
  ] as const)("matches CPA candidate rules for %j %s", async (headers, path, expected) => {
    const { guard } = setup();
    expect(await guard.authorize(request(headers, path))).toBe(expected);
  });

  it("uses Go Unicode whitespace for configured keys and Bearer tokens, not for other candidates", async () => {
    const { guard } = setup('access: {api-keys: ["\\u0085client-alpha\\u0085"]}');
    expect(await guard.authorize(request({ authorization: "Bearer \u0085client-alpha\u0085" }))).toBe("allowed");
    expect(await guard.authorize(request({ "x-api-key": "\u0085client-alpha\u0085" }))).toBe("denied");
  });

  it("preserves the BOM character that Go does not trim from keys", async () => {
    const { guard } = setup('access: {api-keys: ["\\ufeffclient-alpha\\ufeff"]}');
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }))).toBe("denied");
    expect(await guard.authorize(request({}, "/v1/models?key=%EF%BB%BFclient-alpha%EF%BB%BF"))).toBe("allowed");
  });

  it("preserves Go's string decoding of scalar client keys instead of coercing their numeric spelling", async () => {
    const { guard } = setup("access: {api-keys: [123, 0x1a, TRUE]}");
    for (const key of ["123", "0x1a", "TRUE"]) {
      expect(await guard.authorize(request({ "x-api-key": key }))).toBe("allowed");
    }
    expect(await guard.authorize(request({ "x-api-key": "26" }))).toBe("denied");
    expect(await guard.authorize(request({ "x-api-key": "true" }))).toBe("denied");
  });

  it.each(["8.0", "!!float 8"])("rejects a floating-point version token even when its numeric value is eight: %s", async (version) => {
    const { guard } = setup(`config-version: ${version}\naccess: {api-keys: [client-alpha]}`);
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }))).toBe("unavailable");
  });

  it("rejects startup example-key safe mode even if another supplied key matches", async () => {
    const { guard, runtime } = setup("access: {api-keys: [client-alpha, your-api-key-1]}");
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }))).toBe("denied");
    runtime.running = true;
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }))).toBe("allowed");
  });
});

describe("plugin and realtime admission", () => {
  it.each([false, true])("preserves the native AI Studio relay authentication while running=%s", async (running) => {
    const { guard } = setup(CONFIGURED, running);
    for (const path of ["/v1/ws", "/v1/ws/"]) {
      expect(await guard.authorize(request({}, path))).toBe("runtime-required");
      expect(await guard.authorize(request({ authorization: "Bearer relay-owned-token" }, path))).toBe("runtime-required");
    }
  });

  it("does not open the native relay for an installation with no configured client keys or auth plugin", async () => {
    const { guard } = setup("access: {api-keys: []}");
    expect(await guard.authorize(request({}, "/v1/ws"))).toBe("unconfigured");
  });

  it("lets an enabled auth plugin authorize the native relay without ordinary static keys", async () => {
    const { guard } = setup("plugins: {enabled: true, configs: {plugin: {enabled: true}}}");
    expect(await guard.authorize(request({}, "/v1/ws"))).toBe("runtime-required");
  });

  it("rejects relay methods that CPA never registers before reading credentials", async () => {
    const { guard, store } = setup();
    expect(await guard.authorize(request({}, "/v1/ws", "POST"))).toBe("not-found");
    expect(store.reads).toEqual([]);
  });

  it.each([
    "plugins: {}", "plugins: {enabled: false, configs: {a: {enabled: true}}}",
    "plugins: {enabled: true, configs: {}}", "plugins: {enabled: true, configs: {a: {}}}",
    "plugins: {enabled: true, configs: {a: {enabled: false}}}",
    "plugins: {dir: plugins, store-sources: [https://registry.example]}",
  ])("does not disable static native startup for inactive plugin config: %s", async (plugins) => {
    const { guard } = setup(`${CONFIGURED}${plugins}`);
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }))).toBe("allowed");
    expect(await guard.authorize(request({ "x-api-key": "wrong" }))).toBe("denied");
  });

  it.each([false, true])("preserves CPA authentication when an enabled plugin may own it (running=%s)", async (running) => {
    const { guard } = setup(`${CONFIGURED}plugins: {enabled: true, configs: {plugin: {enabled: true}}}`, running);
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }))).toBe("runtime-required");
    expect(await guard.authorize(request())).toBe("runtime-required");
  });

  it("recognizes Go YAML's legacy typed boolean spellings for plugin enablement", async () => {
    const { guard } = setup(`${CONFIGURED}plugins: {enabled: yes, configs: {plugin: {enabled: on}}}`);
    expect(await guard.authorize(request())).toBe("runtime-required");
  });

  it.each([
    "plugins: false", "plugins: {enabled: mystery}", "plugins: {enabled: true, configs: []}",
    "plugins: {enabled: true, configs: {plugin: {enabled: mystery}}}",
  ])("fails closed on an unrecognized plugin policy: %s", async (plugins) => {
    const { guard } = setup(`${CONFIGURED}${plugins}`);
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }))).toBe("unavailable");
  });

  it.each([
    ["GET", "/v1/realtime"], ["POST", "/v1/realtime"], ["POST", "/v1/realtime/calls"],
    ["GET", "/v1/realtime/calls/call_1"], ["GET", "/v1/realtime/translations"], ["POST", "/v1/realtime/translations"],
  ])("gives ephemeral credentials priority for %s %s without cold-start fallback", async (method, path) => {
    const { guard, runtime } = setup();
    const call = request({ authorization: "bEaReR ek_session", "x-api-key": "client-alpha" }, path, method);
    expect(await guard.authorize(call)).toBe("denied");
    runtime.running = true;
    expect(await guard.authorize(call)).toBe("runtime-only");
  });

  it.each([
    ["POST", "/v1/live"], ["GET", "/v1/live/call_1"], ["GET", "/v1/responses"], ["POST", "/v1/responses"],
    ["POST", "/v1/realtime/client_secrets"], ["POST", "/v1/realtime/sessions"],
    ["POST", "/v1/realtime/transcription_sessions"], ["POST", "/v1/realtime/translations/client_secrets"],
    ["POST", "/v1/realtime/calls/call_1/hangup"], ["POST", "/v1/realtime/calls/call_1/accept"],
    ["POST", "/v1/realtime/calls/call_1/reject"], ["POST", "/v1/realtime/calls/call_1/refer"],
  ])("keeps ordinary any-candidate static auth for %s %s", async (method, path) => {
    const { guard } = setup();
    expect(await guard.authorize(request({ authorization: "Bearer ek_session", "x-api-key": "client-alpha" }, path, method))).toBe("allowed");
  });

  it("does not reinterpret raw or query ek_ keys as ephemeral Bearer credentials", async () => {
    const { guard } = setup("access: {api-keys: [ek_static]}");
    expect(await guard.authorize(request({ authorization: "ek_static" }, "/v1/realtime"))).toBe("allowed");
    expect(await guard.authorize(request({}, "/v1/realtime?key=ek_static"))).toBe("allowed");
  });

  it("keeps ephemeral precedence ahead of plugin auth", async () => {
    const { guard } = setup(`${CONFIGURED}plugins: {enabled: true, configs: {plugin: {enabled: true}}}`);
    expect(await guard.authorize(request({ authorization: "Bearer ek_session" }, "/v1/realtime"))).toBe("denied");
  });
});

describe("bounded warm mutation compatibility", () => {
  it("lets already-running CPA validate a just-saved key while R2 catches up, without sliding the deadline", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { guard } = setup(CONFIGURED, true);
    const changedKey = request({ "x-api-key": "new-key" });
    expect(await guard.authorize(changedKey)).toBe("denied");
    guard.invalidate();
    now += 34_999;
    expect(await guard.authorize(changedKey)).toBe("runtime-only");
    now += 1;
    expect(await guard.authorize(changedKey)).toBe("denied");
  });

  it("does not start a stopped container or defer missing credentials during that window", async () => {
    const { guard, runtime } = setup(CONFIGURED, true);
    guard.invalidate();
    expect(await guard.authorize(request())).toBe("denied");
    expect(await guard.authorize(request({ authorization: "" }))).toBe("denied");
    expect(await guard.authorize(request({ authorization: "Bearer \u0085" }))).toBe("denied");
    runtime.running = false;
    expect(await guard.authorize(request({ "x-api-key": "new-key" }))).toBe("denied");
  });

  it("delegates a first key pending R2 persistence only to the running protocol-guarded runtime", async () => {
    const { guard, runtime } = setup("access: {api-keys: []}", true);
    guard.invalidate();
    expect(await guard.authorize(request({ "x-api-key": "new-key" }))).toBe("runtime-only");
    runtime.running = false;
    expect(await guard.authorize(request({ "x-api-key": "new-key" }))).toBe("unconfigured");
  });

  it("does not turn storage failure into runtime delegation", async () => {
    const { guard, store } = setup(CONFIGURED, true);
    guard.invalidate();
    store.failure = "get";
    expect(await guard.authorize(request({ "x-api-key": "new-key" }))).toBe("unavailable");
  });
});

describe("built-in API route admission", () => {
  it.each([
    ["GET", "/v1/models"], ["GET", "/v1/models/model-name"],
    ["POST", "/v1/messages"], ["POST", "/v1/messages/count_tokens"], ["POST", "/v1/chat/completions"],
    ["POST", "/v1/completions"], ["POST", "/v1/images/generations"], ["POST", "/v1/images/edits"],
    ["POST", "/v1/videos"], ["POST", "/v1/videos/generations"], ["POST", "/v1/videos/edits"],
    ["POST", "/v1/videos/extensions"], ["GET", "/v1/videos/request_1"],
    ["POST", "/v1/audio/speech"], ["POST", "/v1/tts"], ["POST", "/v1/responses/compact"],
    ["POST", "/v1/alpha/search"], ["GET", "/v1beta/models"], ["POST", "/v1beta/interactions"],
    ["GET", "/v1beta/models/gemini-model"], ["POST", "/v1beta/models/gemini-model:generateContent"],
    ["POST", "/v1beta/models/gemini-model:streamGenerateContent"], ["POST", "/v1beta/models/gemini-model:countTokens"],
    ["POST", "/v1/chat/completions/"], ["GET", "/v1/videos/request_1/"],
    ["GET", "/v1/%6dodels"],
  ])("preserves supported calls and valid trailing-slash redirects for %s %s", async (method, path) => {
    const { guard } = setup();
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }, path, method))).toBe("allowed");
  });

  it.each([
    ["POST", "/v1/embeddings"], ["GET", "/v1/does-not-exist"], ["GET", "/v1/messages"],
    ["DELETE", "/v1/models"], ["HEAD", "/v1/models"], ["POST", "/v1/models"],
    ["POST", "/v1/realtime/unknown"], ["GET", "/v1/realtime/client_secrets"],
    ["POST", "/v1/realtime/calls/a/b/hangup"], ["GET", "/v1/videos/a/b"],
    ["POST", "/v1beta/models/model:unknownMethod"], ["POST", "/v1beta/models/model"],
    ["POST", "/v1beta/models/model:generateContent/"], ["GET", "/v1beta/unknown"],
    ["POST", "/openai/v1/videos"], ["POST", "/backend-api/codex/responses"],
    ["GET", "/v1//models"], ["GET", "/v1/models/a%2fb"], ["GET", "/v1/models/a%5cb"],
  ])("rejects unsupported or already-blocked paths before reading credentials: %s %s", async (method, path) => {
    const { guard, store } = setup();
    store.failure = "get";
    expect(await guard.authorize(request({ "x-api-key": "client-alpha" }, path, method))).toBe("not-found");
    expect(store.reads).toEqual([]);
  });
});
