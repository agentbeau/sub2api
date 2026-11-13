import { afterEach, expect, it, vi } from "vitest";
import { ContainerLifecycle, type ContainerBackend } from "../src/container-lifecycle.ts";

afterEach(() => vi.useRealTimers());

// Controlled model of the suspected platform behavior, not a claim that the mock
// proves Cloudflare's internal inactivity accounting: the DO becomes inactive
// after returning headers although the upstream body still has work remaining.
it("protects a 60-second stream after headers return and releases to ordinary idle at EOF", async () => {
  vi.useFakeTimers();
  let timeout = 0;
  let returned = false;
  const scheduleStop = () => {
    clearTimeout(stopTimer);
    stopTimer = setTimeout(() => {
      stopped = true; backend.running = false;
      if (!ended) { ended = true; body?.close(); }
    }, timeout);
  };
  let stopped = false;
  let ended = false;
  let body: ReadableStreamDefaultController<Uint8Array> | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;
  let chunkTimer: ReturnType<typeof setInterval> | undefined;
  let doneTimer: ReturnType<typeof setTimeout> | undefined;
  const backend: ContainerBackend & { running: boolean } = {
    running: false,
    start() { this.running = true; },
    async setInactivityTimeout(ms) { timeout = Number(ms); if (returned) scheduleStop(); },
    getTcpPort() { return { fetch: async input => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/healthz") return new Response("ok");
      if (path === "/__sub2api/lifecycle") return Response.json({ activity_protocol: 1, frontend_auth_protocol: 1,
        initialization_protocol: 1, initialization_ready: true });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        body = controller;
        chunkTimer = setInterval(() => {
          if (!ended) controller.enqueue(new TextEncoder().encode("data: progress\n\n"));
        }, 5000);
        doneTimer = setTimeout(() => {
          if (!ended) { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); ended = true; controller.close(); }
        }, 60000);
      } }), { headers: { "content-type": "text/event-stream" } });
    } }; },
  };
  const lifecycle = new ContainerLifecycle(backend, { idleTimeout: "30000", environment: async () => ({}), attach: async () => {} });
  const response = await lifecycle.forward(new Request("https://test.invalid/v1/responses", { method: "POST" }));
  expect(timeout).toBe(90000);
  returned = true;
  scheduleStop();
  const text = response.text();
  await vi.advanceTimersByTimeAsync(31000);
  expect(stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(29000);
  expect(await text).toContain("data: progress");
  expect(await text).toContain("[DONE]");
  expect(stopped).toBe(false);
  expect(timeout).toBe(30000);
  await vi.advanceTimersByTimeAsync(30000);
  expect(stopped).toBe(true);
  clearTimeout(stopTimer); clearTimeout(doneTimer); clearInterval(chunkTimer);
});
