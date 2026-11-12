import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import ts from "typescript";

const PROJECT = "https://github.com/agentbeau/sub2api";
const UPSTREAM_LICENSE = readFileSync(new URL("./UPSTREAM_LICENSE", import.meta.url), "utf8").trim();
const LOGO = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#b5f0ce"/><text x="32" y="43" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="750" font-size="35" fill="#11261d">s2</text></svg>')}`;
const HEADER_NAMES = new Set(["x-cpa-version", "x-cpa-build-date", "x-cpa-support-plugin"]);
const OLD_REPOS = new Set([
  "https://github.com/router-for-me/CLIProxyAPI",
  "https://github.com/router-for-me/Cli-Proxy-API-Management-Center",
]);

function displayText(text) {
  return text.replaceAll("CLI Proxy API Management Center", "sub2api Console")
    .replaceAll("CLI Proxy API", "sub2api").replaceAll("CLIProxyAPI", "sub2api")
    .replaceAll("CPAMC", "sub2api").replace(/\bCPA\b/g, "sub2api");
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

function scriptBranding(source) {
  const ast = ts.createSourceFile("panel.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length !== 0) throw new Error("Upstream dashboard JavaScript does not parse");
  const changes = new Map();
  const logoBindings = new Set();
  const seenHeaders = new Set();
  let labels = 0;
  let logos = 0;
  const edit = (node, text) => changes.set(node.getStart(ast), { end: node.end, text: JSON.stringify(text).replaceAll("<", "\\u003c") });

  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      const alt = property(node, "alt"), src = property(node, "src");
      if (alt && src && ts.isStringLiteralLike(alt.initializer) && /^CPAMC(?: logo)?$/.test(alt.initializer.text)
        && ts.isIdentifier(src.initializer)) logoBindings.add(src.initializer.text);
    }
    if (ts.isStringLiteralLike(node) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) {
      const before = node.text;
      let after = before;
      if (HEADER_NAMES.has(before)) {
        seenHeaders.add(before);
        after = before.replace("x-cpa-", "x-sub2api-engine-");
      } else if (ts.isCallExpression(node.parent) && node.parent.expression.getText(ast) === "JSON.parse") {
        try { after = JSON.stringify(jsonLabels(JSON.parse(before))); } catch { /* An unrelated non-JSON argument is not branding data. */ }
      } else if (before.startsWith("https://")) {
        if (ts.isPropertyAssignment(node.parent) && node.parent.name.getText(ast) === "href" && OLD_REPOS.has(before)) after = PROJECT;
        else {
          const url = new URL(before);
          if (["platform.kimi.com", "platform.kimi.ai", "apikey.fan"].includes(url.hostname) && url.searchParams.has("aff")) {
            url.searchParams.delete("aff");
            after = url.href;
          }
        }
      } else if (!before.startsWith("data:")) {
        after = displayText(before);
        if (before === "cpa-management-key" && ts.isPropertyAssignment(node.parent) && node.parent.name.getText(ast) === "name") after = "sub2api-management-key";
      }
      if (after !== before) { edit(node, after); labels += 1; }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);

  // Resolve only the top-level product asset referenced by the observed product
  // alt labels. Provider logos and other embedded images remain intact.
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && logoBindings.has(declaration.name.text)
        && declaration.initializer && ts.isStringLiteralLike(declaration.initializer)
        && declaration.initializer.text.startsWith("data:image/")) {
        edit(declaration.initializer, LOGO);
        logos += 1;
      }
    }
  }
  if (logos !== 1) throw new Error("Upstream dashboard product logo structure changed");
  if (seenHeaders.size !== HEADER_NAMES.size) throw new Error("Upstream dashboard version/capability header readers changed");
  if (labels < 3) throw new Error("Upstream dashboard display labels changed");
  let branded = source;
  for (const [start, change] of [...changes.entries()].sort((a, b) => b[0] - a[0])) {
    branded = branded.slice(0, start) + change.text + branded.slice(change.end);
  }
  const checked = ts.createSourceFile("branded.js", branded, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  if (checked.parseDiagnostics.length !== 0) throw new Error("Branded dashboard JavaScript does not parse");
  return { source: branded, labels, logos };
}

// Parse JavaScript before editing literal values; never run a global replacement
// over identifiers, native protocol names, provider artwork or license comments.
export function brandPanel(html) {
  if (!/<html\b/i.test(html) || !/<title>CLI Proxy API Management Center<\/title>/.test(html)) {
    throw new Error("Unexpected upstream dashboard document");
  }
  const scripts = [...html.matchAll(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi)];
  if (scripts.length !== 1 || !scripts[0][2]) throw new Error("Unexpected upstream dashboard script layout");
  const script = scripts[0];
  const result = scriptBranding(script[2]);
  let branded = html.slice(0, script.index) + script[1] + result.source + script[3] + html.slice(script.index + script[0].length);
  branded = branded.replace(/<title>[^<]*<\/title>/, "<title>sub2api Console</title>")
    .replace(/<link\b(?=[^>]*\brel=["']icon["'])[^>]*>/i, `<link rel="icon" type="image/svg+xml" href="${LOGO}">`);
  branded = branded.replace(/<!doctype html>/i, `<!doctype html>\n<!-- Derived dashboard license; product branding modified by sub2api.\n${UPSTREAM_LICENSE}\n-->`);
  return { html: branded, labels: result.labels, logos: result.logos };
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
  console.log(JSON.stringify({ product: "sub2api", sourceSha256: sourceHash, brandedSha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, changedLiterals: result.labels, productLogos: result.logos }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
