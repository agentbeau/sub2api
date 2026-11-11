import { initSync } from "../gateway-rs/pkg/gateway_core.js";
import module from "../gateway-rs/pkg/gateway_core_bg.wasm";

// Wrangler supplies a compiled Wasm module; Vitest uses the same generated
// bindings and bytes through its Wasm loader.
initSync({ module });

export { classify, handleGateway, minPasswordLength } from "../gateway-rs/pkg/gateway_core.js";
