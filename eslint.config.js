import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.wrangler/**", "gateway-rs/pkg/**", "gateway-rs/target/**", "dist/**", "worker-configuration.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { console: "readonly", crypto: "readonly", btoa: "readonly", atob: "readonly" } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "no-warning-comments": "error",
    },
  },
  {
    files: ["**/scripts/*.mjs"],
    languageOptions: { globals: { process: "readonly", fetch: "readonly", URL: "readonly", URLSearchParams: "readonly", Request: "readonly", Response: "readonly", WebAssembly: "readonly", AbortSignal: "readonly", WebSocket: "readonly", setTimeout: "readonly", clearTimeout: "readonly" } },
  },
);
