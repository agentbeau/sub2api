import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { brandPanel } from "./brand.mjs";

function fixture(extra = "") {
  return `<!doctype html><html><head><link rel="icon" href="old-logo.svg"><title>CLI Proxy API Management Center</title></head><body><script type="module">
// Upstream copyright and license must remain.
var logo = 'data:image/png;base64,AAAA';
var image = {src:logo,alt:'CPAMC logo'};
var headerNames=['x-cpa-version','x-cpa-build-date','x-cpa-support-plugin'];
var labels={title:'CLI Proxy API Management Center',abbr:'CPAMC',warning:'CPA reads log files.',cpa_file_logging_required:'Enable CPA logging'};
var translations=JSON.parse('{"cli_proxy_api_source":"CLIProxyAPI source","nested":{"label":"CPA update"}}');
var protocol='client_version=cpa';var managementRoute='/v8/management/config';
var source={href:'https://github.com/router-for-me/CLIProxyAPI'};
var provider='https://platform.kimi.com/?aff=cliproxyapi';
${extra}
</script></body></html>`;
}

test("brands display strings, parsed translations, product logo and header readers while preserving native protocol", () => {
  const result = brandPanel(fixture());
  assert.match(result.html, /<title>sub2api Console<\/title>/);
  assert.match(result.html, /Upstream copyright and license must remain/);
  assert.match(result.html, /Copyright \(c\) 2026 Router-For.ME/);
  const script = result.html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1];
  const context = {};
  runInNewContext(script, context);
  assert.equal(context.labels.title, "sub2api Console");
  assert.equal(context.labels.abbr, "sub2api");
  assert.equal(context.labels.cpa_file_logging_required, "Enable sub2api logging");
  assert.equal(context.translations.cli_proxy_api_source, "sub2api source");
  assert.equal(context.translations.nested.label, "sub2api update");
  assert.equal(context.protocol, "client_version=cpa");
  assert.equal(context.managementRoute, "/v8/management/config");
  assert.equal(context.source.href, "https://github.com/agentbeau/sub2api");
  assert.equal(context.provider, "https://platform.kimi.com/");
  assert.match(context.image.src, /^data:image\/svg\+xml,/);
  assert.equal(context.image.alt, "sub2api logo");
  assert.deepEqual(Array.from(context.headerNames), ['x-sub2api-engine-version','x-sub2api-engine-build-date','x-sub2api-engine-support-plugin']);
});

test("does not replace protocol identifiers, translation keys, provider artwork or license text", () => {
  const result = brandPanel(fixture("var providerLogo='data:image/png;base64,CPAXYZ';var cpaInternal={CPA:'protocol-name'}; /* CLIProxyAPI license */"));
  assert.match(result.html, /data:image\/png;base64,CPAXYZ/);
  assert.match(result.html, /cpaInternal=\{CPA:'protocol-name'\}/);
  assert.match(result.html, /\/\* CLIProxyAPI license \*\//);
  assert.match(result.html, /cpa_file_logging_required:/);
});

test("refuses changed upstream structure instead of silently shipping a partial rebrand", () => {
  assert.throws(() => brandPanel(fixture().replace("alt:'CPAMC logo'", "alt:'Unknown product'")), /logo/);
  assert.throws(() => brandPanel(fixture().replace("x-cpa-version", "unexpected-version-header")), /header/);
  assert.throws(() => brandPanel(fixture("var invalid = ;")), /JavaScript/);
  assert.throws(() => brandPanel("not an HTML dashboard"), /dashboard/);
});
