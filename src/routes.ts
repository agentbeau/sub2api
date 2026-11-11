import { classify as classifyRust } from "./wasm.ts";

export type Route = "api" | "health" | "ready" | "oauth-callback" | "dashboard" | "home" | "login" | "logout" | "blocked";

export function classify(pathname: string): Route {
  return classifyRust(pathname) as Route;
}
