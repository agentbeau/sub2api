import { isMap, parseDocument, visit } from "yaml";
import { apiRoute } from "./api-routes.ts";
import type { ApiAccessDecision } from "./gateway.ts";
import { CONFIG_KEY, IMPORT_KEY } from "./import-config.ts";

export interface AccessStore {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export type AccessDecision = ApiAccessDecision | "runtime-only" | "runtime-required";

const MUTATION_GRACE_MS = 35_000;
const EXAMPLE_KEYS = new Set(["your-api-key-1", "your-api-key-2", "your-api-key-3"]);
// Go strings.TrimSpace uses Unicode White_Space, including NEL but excluding BOM.
const GO_WHITESPACE = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

interface AccessPolicy {
  keys: Set<string>;
  dynamicAuth: boolean;
}

// Go's typed string decoder preserves a scalar's spelling (0x1a is the key
// "0x1a", not "26"). Retain that spelling through YAML alias/merge resolution.
class ConfigScalar {
  constructor(readonly value: number | bigint | boolean, readonly source: string) {}
}

function trimGo(value: string): string {
  return value.replace(GO_WHITESPACE, "");
}

function mapping(value: unknown): Map<unknown, unknown> {
  if (!(value instanceof Map)) throw new Error("Invalid configuration mapping");
  return value;
}

function acyclic(value: unknown, active = new Set<object>(), checked = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (active.has(value)) throw new Error("Cyclic configuration");
  if (checked.has(value)) return;
  active.add(value);
  if (value instanceof Map) {
    for (const [key, child] of value) {
      acyclic(key, active, checked);
      acyclic(child, active, checked);
    }
  } else if (Array.isArray(value)) {
    for (const child of value) acyclic(child, active, checked);
  }
  active.delete(value);
  checked.add(value);
}

function configuredBoolean(value: unknown): boolean {
  if (value instanceof ConfigScalar) value = value.value;
  if (value === undefined || value === null) return false;
  if (typeof value === "string") {
    // yaml.v3 also accepts these YAML 1.1 spellings for explicitly typed bools.
    if (["y", "Y", "yes", "Yes", "YES", "on", "On", "ON"].includes(value)) return true;
    if (["n", "N", "no", "No", "NO", "off", "Off", "OFF"].includes(value)) return false;
  }
  if (typeof value !== "boolean") throw new Error("Invalid configured boolean");
  return value;
}

function pluginsMayAuthenticate(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const plugins = mapping(value);
  const enabled = configuredBoolean(plugins.get("enabled"));
  const configs = plugins.get("configs");
  if (configs === undefined || configs === null) return false;
  let anyEnabled = false;
  for (const [id, config] of mapping(configs)) {
    if (typeof id !== "string") throw new Error("Invalid plugin identifier");
    // CPA normalizes absent/non-mapping instance config to disabled.
    if (config instanceof Map && configuredBoolean(config.get("enabled"))) anyEnabled = true;
  }
  return enabled && anyEnabled;
}

function readPolicy(text: string, imported: boolean): AccessPolicy {
  const document = parseDocument(text, { merge: true, uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents)) {
    throw new Error("Invalid configuration document");
  }
  visit(document, { Scalar(key, node) {
    if (key !== "key" && (typeof node.value === "number" || typeof node.value === "bigint" || typeof node.value === "boolean")) {
      node.value = new ConfigScalar(node.value, node.source ?? String(node.value));
    }
  } });
  const root = mapping(document.toJS({ mapAsMap: true, maxAliasCount: 100 }));
  acyclic(root);
  // The entrypoint replaces config-version and its owned server/management fields
  // in a pending import. Canonical CPA configuration must already use version 8.
  const version = root.get("config-version");
  if (!imported && root.has("config-version")
    && (!(version instanceof ConfigScalar) || version.value !== 8 || version.source !== "8")) throw new Error("Unsupported config version");

  let configuredKeys = root.get("api-keys");
  if (configuredKeys instanceof Map) configuredKeys = undefined; // v8 upstream groups
  if (root.has("access")) {
    const access = mapping(root.get("access"));
    if (access.has("api-keys")) configuredKeys = access.get("api-keys");
  }
  if (configuredKeys !== undefined && configuredKeys !== null && !Array.isArray(configuredKeys)) throw new Error("Invalid client key list");
  const keys = new Set<string>();
  for (const key of (configuredKeys ?? []) as unknown[]) {
    // yaml.v3 omits null elements when decoding a typed string slice.
    if (key === null) continue;
    const value = key instanceof ConfigScalar ? key.source : key;
    if (typeof value !== "string") throw new Error("Invalid client key");
    const normalized = trimGo(value);
    if (normalized !== "") keys.add(normalized);
  }
  return { keys, dynamicAuth: pluginsMayAuthenticate(root.get("plugins")) };
}

function candidates(request: Request, url: URL): string[] {
  const authorization = request.headers.get("authorization") ?? "";
  const separator = authorization.indexOf(" ");
  const bearer = separator !== -1 && authorization.slice(0, separator).toLowerCase() === "bearer"
    ? trimGo(authorization.slice(separator + 1)) : authorization;
  return [
    bearer,
    request.headers.get("x-goog-api-key") ?? "",
    request.headers.get("x-api-key") ?? "",
    url.searchParams.get("key") ?? "",
    url.searchParams.get("auth_token") ?? "",
  ];
}

function isEphemeralBearer(request: Request): boolean {
  const header = trimGo(request.headers.get("authorization") ?? "");
  return header.slice(0, 7).toLowerCase() === "bearer " && trimGo(header.slice(7)).startsWith("ek_");
}

export class KeyGuard {
  private mutationUntil = 0;

  constructor(private readonly store: AccessStore, private readonly isRunning: () => boolean) {}

  async authorize(request: Request): Promise<AccessDecision> {
    const url = new URL(request.url);
    const route = apiRoute(request.method, url.pathname);
    if (route === null) return "not-found";
    try {
      const canonical = await this.store.get(CONFIG_KEY);
      const object = canonical ?? await this.store.get(IMPORT_KEY);
      const policy = object === null ? { keys: new Set<string>(), dynamicAuth: false }
        : readPolicy(await object.text(), canonical === null);
      const running = this.isRunning();

      if (!running && [...policy.keys].some((key) => EXAMPLE_KEYS.has(key))) return "denied";
      if (route === "realtime" && isEphemeralBearer(request)) return running ? "runtime-only" : "denied";
      // Plugin capabilities come from the loaded binary, not the YAML. Preserve
      // native startup when only CPA can determine the effective authentication.
      if (policy.dynamicAuth) return "runtime-required";
      // AI Studio's relay has its own optional ws-auth policy. Preserve that
      // native handshake while retaining the installation's client-key setup gate.
      if (route === "relay") return policy.keys.size === 0 ? "unconfigured" : "runtime-required";

      const supplied = candidates(request, url);
      if (supplied.some((key) => key !== "" && policy.keys.has(key))) return "allowed";
      // A management save may reach the running CPA before its R2 upload. This
      // bounded fallback never starts a stopped process and never slides on reads.
      // Cpa MUST require frontend_auth_protocol:1 before forwarding: its real
      // zero-provider rejection makes first-key creation and last-key deletion
      // safe while the authoritative R2 object catches up with the running process.
      if (running && Date.now() < this.mutationUntil && supplied.some((key) => key !== "")) return "runtime-only";
      return policy.keys.size === 0 ? "unconfigured" : "denied";
    } catch {
      return "unavailable";
    }
  }

  invalidate(): void {
    this.mutationUntil = Date.now() + MUTATION_GRACE_MS;
  }
}
