import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import ts from "typescript";

const UPSTREAM_LICENSE = readFileSync(new URL("./UPSTREAM_LICENSE", import.meta.url), "utf8").trim();
const HEADER_NAMES = new Set(["x-cpa-version", "x-cpa-build-date", "x-cpa-support-plugin"]);
const PRODUCT_REPOS = new Set([
  "https://github.com/router-for-me/CLIProxyAPI",
  "https://github.com/router-for-me/Cli-Proxy-API-Management-Center",
  "https://github.com/agentbeau/sub2api",
]);
const UI_KEYS = new Map([
  ["cli-proxy-auth", "console-auth"],
  ["cli-proxy-theme", "console-theme"],
  ["cli-proxy-language", "console-language"],
]);

function displayText(text) {
  if (/^(?:CLI Proxy API Management Center|CLI Proxy API|CLIProxyAPI|CPAMC|CPA|sub2api)$/.test(text)) return "Console";
  return text.replaceAll("CLI Proxy API Management Center", "Management console")
    .replaceAll("CLI Proxy API", "gateway").replaceAll("CLIProxyAPI", "gateway")
    .replaceAll("CPAMC", "console").replace(/\bCPA\b/g, "gateway").replace(/\bsub2api\b/gi, "gateway");
}

function jsonLabels(value) {
  if (typeof value === "string") return value.startsWith("http") || value.startsWith("data:") ? value : displayText(value);
  if (Array.isArray(value)) return value.map(jsonLabels);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonLabels(item)]));
  return value;
}

function property(node, name) {
  return node.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText().replace(/^['"]|['"]$/g, "") === name);
}

function elementCall(node, tag, ast) {
  const call = node.parent;
  return ts.isCallExpression(call) && call.arguments[1] === node
    && ts.isStringLiteralLike(call.arguments[0]) && call.arguments[0].text === tag
    && /\.(?:jsx|jsxs|createElement)\b/.test(call.expression.getText(ast)) ? call : undefined;
}

function scriptBranding(source) {
  const ast = ts.createSourceFile("panel.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length !== 0) throw new Error("Upstream dashboard JavaScript does not parse");
  const changes = new Map();
  const logoBindings = new Set();
  const seenHeaders = new Set();
  let labels = 0, logos = 0, removedElements = 0;
  const replace = (node, text) => changes.set(node.getStart(ast), { end: node.end, text });
  const edit = (node, text) => replace(node, JSON.stringify(text).replaceAll("<", "\\u003c"));

  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const alt = property(node, "alt"), src = property(node, "src"), href = property(node, "href");
      if (alt && src && ts.isStringLiteralLike(alt.initializer) && /^CPAMC(?: logo)?$/.test(alt.initializer.text)
        && ts.isIdentifier(src.initializer)) {
        logoBindings.add(src.initializer.text);
        const call = elementCall(node, "img", ast);
        if (call) { replace(call, "null"); removedElements += 1; return; }
        edit(alt.initializer, "");
      }
      if (href && ts.isStringLiteralLike(href.initializer) && PRODUCT_REPOS.has(href.initializer.text)) {
        const call = elementCall(node, "a", ast);
        if (call) { replace(call, "null"); removedElements += 1; return; }
        edit(href.initializer, "");
      }
    }
    if (ts.isStringLiteralLike(node) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) {
      // A parent may have already cleared a product-only attribute.
      if (changes.has(node.getStart(ast))) return;
      const before = node.text;
      let after = before;
      if (HEADER_NAMES.has(before)) {
        seenHeaders.add(before);
        after = before.replace("x-cpa-", "x-engine-");
      } else if (UI_KEYS.has(before)) {
        after = UI_KEYS.get(before);
      } else if (PRODUCT_REPOS.has(before) && ts.isPropertyAssignment(node.parent)
        && node.parent.name.getText(ast).replace(/^['"]|['"]$/g, "") === "placeholder") {
        // Clear a product-specific hint, never the user's configured source URL.
        after = "";
      } else if (ts.isCallExpression(node.parent) && node.parent.expression.getText(ast) === "JSON.parse") {
        try { after = JSON.stringify(jsonLabels(JSON.parse(before))); } catch { /* Unrelated non-JSON arguments are not display data. */ }
      } else if (before.startsWith("https://")) {
        const url = new URL(before);
        if (["platform.kimi.com", "platform.kimi.ai", "apikey.fan"].includes(url.hostname) && url.searchParams.has("aff")) {
          url.searchParams.delete("aff");
          after = url.href;
        }
      } else if (!before.startsWith("data:")) {
        after = displayText(before);
        if (["cpa-management-key", "sub2api-management-key"].includes(before)
          && ts.isPropertyAssignment(node.parent) && node.parent.name.getText(ast) === "name") after = "management-key";
      }
      if (after !== before) { edit(node, after); labels += 1; }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);

  // Remove the unused product artwork bytes, not provider artwork or QR codes.
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && logoBindings.has(declaration.name.text)
        && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)
        && declaration.initializer.text.startsWith("data:image/")) {
        edit(declaration.initializer, "data:,");
        logos += 1;
      }
    }
  }
  if (logos !== 1) throw new Error("Upstream dashboard product logo structure changed");
  if (seenHeaders.size !== HEADER_NAMES.size) throw new Error("Upstream dashboard version/capability header readers changed");
  if (labels < 3) throw new Error("Upstream dashboard display labels changed");
  let neutral = source;
  for (const [start, change] of [...changes.entries()].sort((a, b) => b[0] - a[0])) {
    neutral = neutral.slice(0, start) + change.text + neutral.slice(change.end);
  }
  const checked = ts.createSourceFile("neutral.js", neutral, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  if (checked.parseDiagnostics.length !== 0) throw new Error("Neutral dashboard JavaScript does not parse");
  return { source: neutral, labels, logos, removedElements };
}

// Edit only parsed display literals and identified product elements. Protocol
// values, provider identities, trust comparisons and required licenses stay intact.
export function brandPanel(html) {
  if (!/<html\b/i.test(html) || !/<title>CLI Proxy API Management Center<\/title>/.test(html)) {
    throw new Error("Unexpected upstream dashboard document");
  }
  const scripts = [...html.matchAll(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi)];
  if (scripts.length !== 1 || !scripts[0][2]) throw new Error("Unexpected upstream dashboard script layout");
  const script = scripts[0];
  const result = scriptBranding(script[2]);
  let neutral = html.slice(0, script.index) + script[1] + result.source + script[3] + html.slice(script.index + script[0].length);
  neutral = neutral.replace(/<title>[^<]*<\/title>/, "<title>Console</title>")
    .replace(/<link\b(?=[^>]*\brel=["']icon["'])[^>]*>/i, '<link rel="icon" href="data:,">');
  neutral = neutral.replace(/<!doctype html>/i, `<!doctype html>\n<!-- Third-party dashboard license.\n${UPSTREAM_LICENSE}\n-->`);
  return { html: neutral, labels: result.labels, logos: result.logos, removedElements: result.removedElements };
}

async function main() {
  const [input, target] = process.argv.slice(2);
  if (!input || !target) throw new Error("Usage: node brand.mjs --fetch|input.html output.html");
  let original;
  if (input === "--fetch") {
    const version = process.env.PANEL_VERSION || "latest";
    const base = "https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases";
    const url = version === "latest" ? `${base}/latest/download/management.html` : `${base}/download/${encodeURIComponent(version)}/management.html`;
    const response = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Dashboard download failed with HTTP ${response.status}`);
    original = Buffer.from(await response.arrayBuffer());
  } else original = await readFile(input);
  const sourceHash = createHash("sha256").update(original).digest("hex");
  const expected = (process.env.PANEL_SHA256 ?? "").trim().toLowerCase();
  if (expected && sourceHash !== expected) throw new Error("Upstream panel checksum differs from PANEL_SHA256");
  const result = brandPanel(original.toString("utf8"));
  const bytes = Buffer.from(result.html, "utf8");
  await mkdir(dirname(resolve(target)), { recursive: true });
  await writeFile(target, bytes);
  console.log(JSON.stringify({ presentation: "neutral", sourceSha256: sourceHash, outputSha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, changedLiterals: result.labels, clearedLogos: result.logos, removedElements: result.removedElements }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
