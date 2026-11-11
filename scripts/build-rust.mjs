// Build the small Rust gateway without downloading or changing tools during a build.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { statSync } from "node:fs";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = "0.2.130";

function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, stdio: capture ? "pipe" : "inherit", encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) {
    if (capture && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} failed. Install the toolchain in rust-toolchain.toml and wasm-bindgen-cli ${version}; see README.md.`, { cause: result.error });
  }
  return result.stdout?.trim() ?? "";
}

if (run("wasm-bindgen", ["--version"], true) !== `wasm-bindgen ${version}`) {
  throw new Error(`Use wasm-bindgen-cli ${version}; the CLI and locked Rust dependency must match.`);
}
run("cargo", ["build", "--manifest-path", "gateway-rs/Cargo.toml", "--locked", "--release", "--target", "wasm32-unknown-unknown"]);
run("wasm-bindgen", ["--target", "web", "--out-dir", "gateway-rs/pkg", "--out-name", "gateway_core", "gateway-rs/target/wasm32-unknown-unknown/release/sub2api_gateway.wasm"]);
const bytes = statSync(resolve(root, "gateway-rs/pkg/gateway_core_bg.wasm")).size;
console.log(`Built Rust gateway: ${bytes.toLocaleString("en-US")} bytes of Wasm.`);
