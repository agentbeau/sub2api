import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

export default defineConfig({
  plugins: [{
    name: "actual-gateway-wasm",
    enforce: "pre",
    resolveId(source, importer) {
      if (source.startsWith("\0gateway-wasm:")) return source;
      if (!source.endsWith(".wasm") || importer === undefined) return null;
      return `\0gateway-wasm:${resolve(dirname(importer), source)}`;
    },
    load(id) {
      if (!id.startsWith("\0gateway-wasm:")) return null;
      // Match workerd's Wasm-module import while running the exact compiled bytes in Node.
      const bytes = Array.from(readFileSync(id.slice("\0gateway-wasm:".length)));
      return `export default new WebAssembly.Module(new Uint8Array(${JSON.stringify(bytes)}));`;
    },
  }],
  test: { include: ["test/**/*.test.ts", "worker/test/**/*.test.ts"] },
});
