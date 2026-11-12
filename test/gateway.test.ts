import { describe, expect, it } from "vitest";
import { handle, type ApiAccessDecision, type Forward, type GatewayConfig, type LoginLimiter } from "../src/gateway.ts";
import { classify } from "../src/routes.ts";
import { SESSION_COOKIE, issueSession, passwordMatches, readCookie, sessionIsValid } from "../worker/src/session.ts";

const PASSWORD = "correct-horse-battery-staple-0123456789";
const NOW = 1_800_000_000;
const CLIENT_KEY = "client-key-0123456789abcdef0123456789abcdef";

const unlimited: LoginLimiter = { limit: async () => ({ success: true }) };

function freshConfig(nowSeconds: () => number = () => NOW): GatewayConfig {
  return { dashboardPassword: PASSWORD, nowSeconds, apiAccess: { authorize: async () => "allowed", invalidate() {} }, loginLimiter: unlimited };
}

const config = freshConfig();

function recorder(): { forward: Forward; seen: Request[] } {
  const seen: Request[] = [];
  return {
    seen,
    forward: async (request) => {
      seen.push(request);
      return new Response("from cpa", { status: 200 });
    },
  };
}

function at(path: string, init: RequestInit = {}): Request {
  return new Request(`https://gateway.example${path}`, init);
}

async function sessionCookie(): Promise<string> {
  return `${SESSION_COOKIE}=${await issueSession(PASSWORD, NOW)}`;
}

describe("classify", () => {
  it.each([
    ["/v1/messages", "api"],
    ["/v1/messages/count_tokens", "api"],
    ["/v1/chat/completions", "api"],
    ["/v1beta/models", "api"],
    ["/healthz", "health"],
    ["/readyz", "ready"],
    ["/management.html", "dashboard"],
    ["/provider-panel.html", "dashboard"],
    ["/runtime/status", "dashboard"],
    ["/runtime/start", "dashboard"],
    ["/runtime/stop", "dashboard"],
    ["/v0/management/config", "dashboard"],
    ["/v8/management/oauth/auth-url", "dashboard"],
    ["/", "home"],
    ["/login", "login"],
    ["/logout", "logout"],
    ["/anthropic/callback", "blocked"],
    ["/codex/callback", "blocked"],
    ["/callback", "oauth-callback"],
    ["/auth/callback", "oauth-callback"],
    ["/oauth-callback", "oauth-callback"],
    ["/v1", "blocked"],
    ["/v0/management", "blocked"],
    ["/v1/%2e%2e/v0/management/config", "blocked"],
    ["/v1/..%2Fv0/management/config", "blocked"],
    ["/v1//messages", "blocked"],
  ])("%s is %s", (path, route) => {
    expect(classify(path)).toBe(route);
  });

  it("sees the path after URL normalisation", () => {
    expect(classify(new URL("https://gateway.example/v1/../v0/management/config").pathname)).toBe("dashboard");
  });
});

describe("session", () => {
  it("accepts its own token until it expires", async () => {
    const token = await issueSession(PASSWORD, NOW);
    expect(await sessionIsValid(PASSWORD, token, NOW + 60)).toBe(true);
    expect(await sessionIsValid(PASSWORD, token, NOW + 12 * 60 * 60)).toBe(false);
  });

  it("rejects tokens signed with another password or edited", async () => {
    const token = await issueSession(PASSWORD, NOW);
    expect(await sessionIsValid("another-password", token, NOW)).toBe(false);
    const [, signature] = token.split(".");
    expect(await sessionIsValid(PASSWORD, `${NOW + 999_999}.${signature}`, NOW)).toBe(false);
    expect(await sessionIsValid(PASSWORD, "garbage", NOW)).toBe(false);
    expect(await sessionIsValid(PASSWORD, `${token}.extra`, NOW)).toBe(false);
  });

  it("compares passwords exactly and never matches an empty secret", async () => {
    expect(await passwordMatches(PASSWORD, PASSWORD)).toBe(true);
    expect(await passwordMatches(`${PASSWORD}x`, PASSWORD)).toBe(false);
    expect(await passwordMatches("", "")).toBe(false);
  });

  it("reads one cookie out of a header", () => {
    expect(readCookie("a=1; b=two=2; c=3", "b")).toBe("two=2");
    expect(readCookie("a=1", "b")).toBeNull();
    expect(readCookie(null, "b")).toBeNull();
  });
});

describe("handle", () => {
  it.each([
    ["denied", 401],
    ["unconfigured", 401],
    ["unavailable", 503],
    ["not-found", 404],
  ] as const)("rejects %s API admission without probing or forwarding", async (decision, status) => {
    const { forward, seen } = recorder();
    const admitted = { ...freshConfig(), apiAccess: { authorize: async () => decision, invalidate() {} } };
    const request = at("/v1/messages", { method: "POST", headers: { "x-api-key": "invalid" }, body: "{}" });
    const response = await handle(request, admitted, forward);
    expect(response.status).toBe(status);
    expect(seen).toHaveLength(0);
    expect(request.bodyUsed).toBe(false);
    if (decision === "unconfigured") expect(await response.text()).toContain("API Keys in the dashboard");
  });

  it.each(["missing", "empty", "invalid"])("does not wake the provider for %s API credentials rejected by admission", async (kind) => {
    const { forward, seen } = recorder();
    const headers = new Headers();
    if (kind !== "missing") headers.set("x-api-key", kind === "empty" ? "" : "wrong");
    const admitted = { ...freshConfig(), apiAccess: { authorize: async () => "denied" as const, invalidate() {} } };
    const response = await handle(at("/v1/models", { headers }), admitted, forward);
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it.each(["throw", "reject", "unknown"])("fails closed without forwarding when API admission returns %s", async (failure) => {
    const { forward, seen } = recorder();
    const authorize = () => {
      if (failure === "throw") throw new Error("admission unavailable");
      if (failure === "reject") return Promise.reject(new Error("R2 unavailable"));
      // JavaScript callbacks can violate their declared type at the Wasm boundary.
      return Promise.resolve("unexpected-decision" as ApiAccessDecision);
    };
    const response = await handle(at("/v1/models"), { ...freshConfig(), apiAccess: { authorize, invalidate() {} } }, forward);
    expect(response.status).toBe(503);
    expect(seen).toHaveLength(0);
  });

  it("forwards an admitted request once after passing its unread metadata to admission", async () => {
    const { forward, seen } = recorder();
    const request = at("/v1/messages", { method: "POST", headers: { "x-api-key": CLIENT_KEY, cookie: await sessionCookie() }, body: "{}" });
    const admissions: Request[] = [];
    const admitted = { ...freshConfig(), apiAccess: {
      authorize: async (candidate: Request) => {
        admissions.push(candidate);
        expect(candidate).toBe(request);
        expect(candidate.bodyUsed).toBe(false);
        return "allowed" as const;
      },
      invalidate() {},
    } };
    expect((await handle(request, admitted, forward)).status).toBe(200);
    expect(admissions).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://gateway.example/v1/messages");
    expect(seen[0]?.headers.get("x-api-key")).toBe(CLIENT_KEY);
    expect(seen[0]?.headers.get("cookie")).toBeNull();
    expect(await seen[0]?.text()).toBe("{}");
  });

  it.each([
    ["/provider-panel.html", "GET"],
    ["/runtime/status", "GET"],
    ["/runtime/start", "POST"],
    ["/runtime/stop", "POST"],
  ])("requires the existing dashboard session for %s", async (path, method) => {
    const { forward, seen } = recorder();
    expect((await handle(at(path, { method }), config, forward)).status).toBe(401);
    expect(seen).toHaveLength(0);
    const signed = await handle(at(path, { method, headers: { cookie: await sessionCookie() } }), config, forward);
    expect(signed.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.get("cookie")).toBeNull();
  });

  it("asks admission again immediately after a key is added or revoked", async () => {
    const { forward, seen } = recorder();
    let decision: "allowed" | "denied" | "unconfigured" = "unconfigured";
    const admitted = { ...freshConfig(), apiAccess: { authorize: async () => decision, invalidate() {} } };
    const call = () => handle(at("/v1/models", { headers: { "x-api-key": CLIENT_KEY } }), admitted, forward);
    expect((await call()).status).toBe(401);
    expect(seen).toHaveLength(0);
    decision = "allowed";
    expect((await call()).status).toBe(200);
    expect(seen).toHaveLength(1);
    decision = "denied";
    expect((await call()).status).toBe(401);
    expect(seen).toHaveLength(1);
  });

  it("invalidates admission state before and after an authenticated dashboard write", async () => {
    const events: string[] = [];
    const admitted = { ...freshConfig(), apiAccess: {
      authorize: async () => "allowed" as const,
      invalidate: () => { events.push("invalidate"); },
    } };
    const forward: Forward = async () => { events.push("forward"); return new Response("saved"); };
    const response = await handle(at("/v8/management/config/access/api-keys", {
      method: "PUT", headers: { cookie: await sessionCookie() }, body: "[]",
    }), admitted, forward);
    expect(response.status).toBe(200);
    expect(events).toEqual(["invalidate", "forward", "invalidate"]);
  });

  it("answers liveness without waking CPA", async () => {
    const { forward, seen } = recorder();
    const response = await handle(at("/healthz"), config, forward);
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(0);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("probes provider readiness explicitly without forwarding dashboard cookies", async () => {
    const { forward, seen } = recorder();
    expect((await handle(at("/readyz", { headers: { cookie: await sessionCookie() } }), config, forward)).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://gateway.example/healthz");
    expect(seen[0]?.headers.get("cookie")).toBeNull();
  });

  it("shows the sub2api login receipt after forwarding the provider callback for a signed-in user", async () => {
    const { forward, seen } = recorder();
    const response = await handle(
      at("/callback?code=abc&state=f1d66a216e61aab0375b6857db64a6a5", { headers: { cookie: await sessionCookie() } }),
      config,
      forward,
    );
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("Login received");
    expect(page).toContain("sub2api is saving this login");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://gateway.example/v0/management/oauth-callback?code=abc&state=f1d66a216e61aab0375b6857db64a6a5");
    expect(seen[0]?.headers.get("cookie")).toBeNull();
  });

  it("keeps the callback closed without a session", async () => {
    const { forward, seen } = recorder();
    const response = await handle(at("/auth/callback?code=abc&state=xyz"), config, forward);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Sign in");
    expect(seen).toHaveLength(0);
  });

  it("explains a callback the provider refuses", async () => {
    const refused: Forward = async () => Response.json({ status: "error", error: "unknown or expired state" }, { status: 404 });
    const response = await handle(at("/oauth-callback?code=abc&state=xyz", { headers: { cookie: await sessionCookie() } }), config, refused);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).toContain("unknown or expired state");
    expect(text).toContain("Start the login again");
  });

  it("uses a provider label when a refused callback contains no explanatory JSON", async () => {
    const refused: Forward = async () => new Response("upstream unavailable", { status: 503 });
    const response = await handle(at("/oauth-callback?code=abc&state=xyz", { headers: { cookie: await sessionCookie() } }), config, refused);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Provider answered 503");
  });

  it("identifies the signed-out dashboard as sub2api", async () => {
    const { forward, seen } = recorder();
    const response = await handle(at("/login"), config, forward);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Sign in to open the sub2api dashboard.");
    expect(seen).toHaveLength(0);
  });

  it("never forwards blocked paths", async () => {
    const { forward, seen } = recorder();
    for (const path of ["/anthropic/callback?code=x", "/codex/callback", "/devin/callback", "/robots.txt", "/v1"]) {
      expect((await handle(at(path), config, forward)).status).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it("keeps the dashboard closed without a session", async () => {
    const { forward, seen } = recorder();
    const page = await handle(at("/management.html"), config, forward);
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/login");
    const api = await handle(at("/v8/management/config", { headers: { authorization: "Bearer guess" } }), config, forward);
    expect(api.status).toBe(401);
    const forged = await handle(at("/v0/management/config", { headers: { cookie: `${SESSION_COOKIE}=1.abc` } }), config, forward);
    expect(forged.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("opens the dashboard with a valid session", async () => {
    const { forward, seen } = recorder();
    const response = await handle(at("/v8/management/config", { headers: { cookie: await sessionCookie() } }), config, forward);
    expect(response.status).toBe(200);
    expect(seen[0]?.headers.get("cookie")).toBeNull();
  });

  it("signs in with the right password and sets a strict cookie", async () => {
    const { forward } = recorder();
    const response = await handle(
      at("/login", { method: "POST", body: new URLSearchParams({ password: PASSWORD }) }),
      config,
      forward,
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/management.html");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=\\d+\\.[A-Za-z0-9_-]+; `));
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const token = readCookie(cookie.split(";")[0] ?? "", SESSION_COOKIE) ?? "";
    expect(await sessionIsValid(PASSWORD, token, NOW)).toBe(true);
  });

  it("refuses a wrong password", async () => {
    const { forward } = recorder();
    const response = await handle(at("/login", { method: "POST", body: new URLSearchParams({ password: "nope" }) }), config, forward);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("Wrong password.");
  });

  it("starts the session lifetime after asynchronous sign-in checks finish", async () => {
    let now = NOW;
    const delayed = {
      ...freshConfig(() => now),
      loginLimiter: { limit: async () => {
        now += 60;
        return { success: true };
      } },
    };
    const response = await handle(
      at("/login", { method: "POST", body: new URLSearchParams({ password: PASSWORD }) }), delayed, recorder().forward,
    );
    const token = readCookie(response.headers.get("set-cookie"), SESSION_COOKIE) ?? "";
    expect(response.status).toBe(303);
    expect(await sessionIsValid(PASSWORD, token, NOW + 12 * 60 * 60 + 30)).toBe(true);
    expect(await sessionIsValid(PASSWORD, token, NOW + 12 * 60 * 60 + 60)).toBe(false);
  });

  it("stops a chunked login upload when it exceeds the body limit", async () => {
    let chunksRead = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1;
        controller.enqueue(new TextEncoder().encode(chunksRead === 1 ? `password=${PASSWORD}&unused=` : "x".repeat(4096)));
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    const response = await handle(at("/login", { method: "POST", body, duplex: "half" } as RequestInit), freshConfig(), recorder().forward);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(cancelled).toBe(true);
    expect(chunksRead).toBe(2);
  });

  it("does not consume inference uploads or response streams inside the gateway", async () => {
    let responsePulls = 0;
    let finishUpload = () => {};
    let sentUploadChunk = false;
    const upload = new ReadableStream<Uint8Array>({
      start(controller) {
        finishUpload = () => { controller.close(); };
      },
      pull(controller) {
        if (!sentUploadChunk) {
          controller.enqueue(new TextEncoder().encode('{"model":"configured-by-cpa"}'));
          sentUploadChunk = true;
        }
      },
    }, { highWaterMark: 0 });
    const events = new ReadableStream<Uint8Array>({
      pull(controller) {
        responsePulls += 1;
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const upstream = new Response(events, { headers: { "content-type": "text/event-stream" } });
    const received: Request[] = [];
    const forward: Forward = async (request) => {
      received.push(request);
      return upstream;
    };
    const response = await handle(at("/v1/chat/completions", {
      method: "POST", body: upload, duplex: "half", headers: { "x-api-key": CLIENT_KEY, cookie: await sessionCookie() },
    } as RequestInit), freshConfig(), forward);
    expect(response).toBe(upstream);
    expect(responsePulls).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]?.bodyUsed).toBe(false);
    expect(received[0]?.headers.get("x-api-key")).toBe(CLIENT_KEY);
    expect(received[0]?.headers.get("cookie")).toBeNull();
    finishUpload();
    expect(await received[0]?.text()).toBe('{"model":"configured-by-cpa"}');
    expect(await response.text()).toBe("data: first\n\n");
  });

  it("limits sign-in attempts per client address", async () => {
    const { forward } = recorder();
    const seen: string[] = [];
    const limited = { ...config, loginLimiter: { limit: async ({ key }: { key: string }) => ({ success: seen.push(key) <= 1 }) } };
    const attempt = () =>
      handle(at("/login", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7" }, body: new URLSearchParams({ password: PASSWORD }) }), limited, forward);
    expect((await attempt()).status).toBe(303);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("set-cookie")).toBeNull();
    expect(await blocked.text()).toContain("Too many sign-in attempts");
    expect(seen).toEqual(["203.0.113.7", "203.0.113.7"]);
  });

  it("turns sign-in off while the dashboard password is missing or short", async () => {
    const { forward } = recorder();
    const weak = { ...config, dashboardPassword: "short" };
    const form = await handle(at("/login"), weak, forward);
    expect(await form.text()).toContain("Sign-in is off");
    const attempt = await handle(at("/login", { method: "POST", body: new URLSearchParams({ password: "short" }) }), weak, forward);
    expect(attempt.status).toBe(503);
    expect(attempt.headers.get("set-cookie")).toBeNull();
    const forgedWithKnownPassword = `${SESSION_COOKIE}=${await issueSession("short", NOW)}`;
    const dashboard = await handle(at("/v8/management/config", { headers: { cookie: forgedWithKnownPassword } }), weak, forward);
    expect(dashboard.status).toBe(401);
  });

  it("sends the home page to login or the dashboard", async () => {
    const { forward } = recorder();
    expect((await handle(at("/"), config, forward)).headers.get("location")).toBe("/login");
    const signed = await handle(at("/", { headers: { cookie: await sessionCookie() } }), config, forward);
    expect(signed.headers.get("location")).toBe("/management.html");
  });

  it("serves the login form and clears the cookie on logout", async () => {
    const { forward } = recorder();
    const form = await handle(at("/login"), config, forward);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('name="password"');
    const out = await handle(at("/logout"), config, forward);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
