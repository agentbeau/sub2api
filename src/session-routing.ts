import { sessionShard } from "./pool-coordination.ts";

export const POOL_SESSION_SHARD_COUNT = 3;
export const SINGLETON_OWNER_NAME = "cf-singleton-container";
const MAX_SESSION_BODY_BYTES = 256 * 1024;

const SESSION_HEADERS = [
  "x-claude-code-session-id",
  "session-id",
  "session_id",
  "thread-id",
  "thread_id",
  "x-http-session-id",
  "x-session-id",
  "x-session-affinity",
  "x-slot-session-id",
  "x-conversation-id",
  "x-task-id",
] as const;

const PARENT_HEADERS = [
  "x-codex-parent-thread-id",
  "x-parent-session-id",
  "x-parent-session-affinity",
  "x-parent-thread-id",
  "x-parent-conversation-id",
  "x-parent-task-id",
] as const;

// Keep this list aligned with CPA v8.0.67's explicit session metadata. We do
// not derive an owner from prompts or conversation text. `previous_response_id`
// alone deliberately stays on the preserved singleton, which also keeps
// existing server-side Responses continuations valid during a pool migration.
const SESSION_FIELDS = [
  "session_id", "sessionId", "sessionID", "child_session_id", "childSessionId",
  "task_id", "taskId", "taskID", "action_id", "actionId",
  "cachedContent", "cached_content", "thread_id", "threadId",
  "conversation_id", "conversationId", "chat_id", "chatId",
  "prompt_cache_key", "promptCacheKey",
  "metadata.session_id", "metadata.sessionId", "metadata.task_id", "metadata.taskId",
  "metadata.thread_id", "metadata.conversation_id",
  "extra_body.session_id", "extra_body.task_id",
] as const;

const PARENT_FIELDS = [
  "parent_session_id", "parentSessionId", "parentSessionID",
  "parent_thread_id", "parentThreadId", "parentThreadID",
  "forked_from_thread_id", "forked_from_id", "parent_conversation_id", "parentConversationId",
  "parent_id", "parentId", "parentID", "parent_task_id", "parentTaskId",
  "parent_action_id", "parentActionId", "parent_session", "parentSession",
  "parent_subagent_id", "previousSessionId", "previous_session_id",
  "metadata.parent_session_id", "metadata.parentSessionId", "metadata.parent_thread_id",
  "metadata.forked_from_thread_id", "metadata.forked_from_id", "metadata.parent_id",
  "metadata.parent_task_id", "metadata.parent_agent_id",
  "extra_body.parent_session_id", "extra_body.parent_thread_id", "extra_body.parent_id",
  "extra_body.parent_task_id",
] as const;

function normalize(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length === 0 || new TextEncoder().encode(normalized).byteLength > 256) return undefined;
  for (let index = 0; index < normalized.length; index++) {
    const code = normalized.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return normalized;
}

function atPath(root: unknown, path: string): unknown {
  let value = root;
  for (const part of path.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function candidateFromPayload(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const nested = typeof root.request === "object" && root.request !== null && !Array.isArray(root.request)
    && !Object.hasOwn(root, "contents") ? [root.request, root] : [root];

  for (const bodyRoot of nested) {
    for (const field of SESSION_FIELDS) {
      const id = normalize(atPath(bodyRoot, field));
      if (id !== undefined) return id;
    }
    const conversation = atPath(bodyRoot, "conversation");
    const conversationId = normalize(typeof conversation === "object" && conversation !== null && !Array.isArray(conversation)
      ? (conversation as Record<string, unknown>).id : conversation);
    if (conversationId !== undefined) return conversationId;
  }
  for (const bodyRoot of nested) {
    for (const field of PARENT_FIELDS) {
      const id = normalize(atPath(bodyRoot, field));
      if (id !== undefined) return id;
    }
  }
  return undefined;
}

async function boundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (contentType !== "application/json" && !/^application\/[a-z0-9.+-]+\+json$/.test(contentType)) return undefined;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_SESSION_BODY_BYTES)) return undefined;
  let clone: Request;
  try {
    clone = request.clone();
  } catch {
    return undefined;
  }
  const reader = clone.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_SESSION_BODY_BYTES - size) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      size += value.byteLength;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

export function sessionOwnerName(sessionId: string): string {
  const shard = sessionShard(sessionId, POOL_SESSION_SHARD_COUNT);
  // Preserve the original Durable Object identity for shard zero. New names are
  // versioned and fixed so restarts and routine deploys do not move sessions.
  return shard === 0 ? SINGLETON_OWNER_NAME : `cf-session-owner-v1-${shard}`;
}

export async function ownerNameForRequest(request: Request, enabled: boolean): Promise<string> {
  if (!enabled || request.method !== "POST") return SINGLETON_OWNER_NAME;
  const claudeSession = normalize(request.headers.get("x-claude-code-session-id"));
  if (claudeSession !== undefined) return sessionOwnerName(claudeSession);

  // CPA gives Claude metadata.user_id priority over generic session headers.
  const payload = await boundedJson(request);
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const root = payload as Record<string, unknown>;
    const claudeUserId = normalize(atPath(root, "metadata.user_id"));
    if (claudeUserId !== undefined) {
      if (claudeUserId.startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(claudeUserId);
          const session = normalize(atPath(parsed, "session_id"));
          if (session !== undefined) return sessionOwnerName(session);
        } catch {
          // Continue to the ordinary protocol fields below.
        }
      }
      const legacy = /_session_([a-f0-9-]{1,128})$/i.exec(claudeUserId)?.[1];
      if (legacy !== undefined) return sessionOwnerName(legacy);
    }
  }
  const prioritizedHeaders = SESSION_HEADERS.filter(header => header !== "x-claude-code-session-id");
  for (const header of prioritizedHeaders) {
    const id = normalize(request.headers.get(header));
    if (id !== undefined) return sessionOwnerName(id);
  }
  const codexMetadata = request.headers.get("x-codex-turn-metadata");
  if (codexMetadata !== null) {
    try {
      const id = candidateFromPayload(JSON.parse(codexMetadata) as unknown);
      if (id !== undefined) return sessionOwnerName(id);
    } catch {
      // Invalid optional affinity metadata falls back to the existing singleton.
    }
  }
  for (const header of PARENT_HEADERS) {
    const id = normalize(request.headers.get(header));
    if (id !== undefined) return sessionOwnerName(id);
  }
  const id = candidateFromPayload(payload);
  return id === undefined ? SINGLETON_OWNER_NAME : sessionOwnerName(id);
}
