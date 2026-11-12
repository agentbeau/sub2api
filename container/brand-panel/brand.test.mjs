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
var labels={title:'CLI Proxy API Management Center',abbr:'CPAMC',warning:'CPA reads log files.',cpa_file_logging_required:'Enable CPA logging',former:'sub2api'};
var translations=JSON.parse('{"cli_proxy_api_source":"CLIProxyAPI source","nested":{"label":"CPA update"}}');
var protocol='client_version=cpa';var managementRoute='/v8/management/config';
var source={href:'https://github.com/router-for-me/CLIProxyAPI'};
var provider='https://platform.kimi.com/?aff=cliproxyapi';
var storage=['cli-proxy-auth','cli-proxy-theme','cli-proxy-language'];
var input={name:'cpa-management-key'};
${extra}
</script></body></html>`;
}

function evaluate(html) {
  const context = {};
  runInNewContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1], context);
  return context;
}

test("removes product branding without introducing another product name or logo", () => {
  const result = brandPanel(fixture());
  assert.match(result.html, /<title>Console<\/title>/);
  assert.match(result.html, /<link rel="icon" href="data:,">/);
  assert.match(result.html, /Upstream copyright and license must remain/);
  assert.match(result.html, /Copyright \(c\) 2026 Router-For.ME/);
  const context = evaluate(result.html);
  assert.equal(context.labels.title, "Console");
  assert.equal(context.labels.abbr, "Console");
  assert.equal(context.labels.former, "Console");
  assert.equal(context.labels.cpa_file_logging_required, "Enable gateway logging");
  assert.equal(context.translations.cli_proxy_api_source, "gateway source");
  assert.equal(context.translations.nested.label, "gateway update");
  assert.equal(context.protocol, "client_version=cpa");
  assert.equal(context.managementRoute, "/v8/management/config");
  assert.equal(context.source.href, "");
  assert.equal(context.provider, "https://platform.kimi.com/");
  assert.equal(context.image.src, "data:,");
  assert.equal(context.image.alt, "");
  assert.equal(context.input.name, "management-key");
  assert.deepEqual(Array.from(context.storage), ['console-auth','console-theme','console-language']);
  assert.deepEqual(Array.from(context.headerNames), ['x-engine-version','x-engine-build-date','x-engine-support-plugin']);
  assert.doesNotMatch(result.html, /sub2api|data:image\/png;base64,AAAA|old-logo\.svg/);
});

test("removes actual product image and repository link elements, not just their labels", () => {
  const result = brandPanel(fixture(`
var renderer={jsx:function(tag,props){return {tag,props};},jsxs:function(tag,props){return {tag,props};}};
var logoElement=(0,renderer.jsx)('img',{src:logo,alt:'CPAMC logo'});
var aboutLogo=(0,renderer.jsx)('img',{src:logo,alt:'CPAMC'});
var sourceLink=(0,renderer.jsxs)('a',{href:'https://github.com/router-for-me/CLIProxyAPI',children:'CLIProxyAPI source'});
var panelLink=(0,renderer.jsx)('a',{href:'https://github.com/router-for-me/Cli-Proxy-API-Management-Center',children:'CPAMC source'});
var previousLink=(0,renderer.jsx)('a',{href:'https://github.com/agentbeau/sub2api',children:'sub2api'});
var providerLink=(0,renderer.jsx)('a',{href:'https://platform.kimi.com/',children:'Kimi'});
`));
  const context = evaluate(result.html);
  for (const name of ['logoElement','aboutLogo','sourceLink','panelLink','previousLink']) assert.equal(context[name], null);
  assert.equal(result.removedElements, 5);
  assert.equal(context.providerLink.props.children, 'Kimi');
  assert.doesNotMatch(result.html, /github\.com\/(?:router-for-me|agentbeau)/);
});

test("preserves protocol identifiers, translation keys, provider artwork, publisher trust and license text", () => {
  const result = brandPanel(fixture("var providerLogo='data:image/png;base64,CPAXYZ';var cpaInternal={CPA:'protocol-name'};var trustedPublisher='router-for-me'; /* CLIProxyAPI license */"));
  assert.match(result.html, /data:image\/png;base64,CPAXYZ/);
  assert.match(result.html, /cpaInternal=\{CPA:'protocol-name'\}/);
  assert.match(result.html, /trustedPublisher='router-for-me'/);
  assert.match(result.html, /\/\* CLIProxyAPI license \*\//);
  assert.match(result.html, /cpa_file_logging_required:/);
});

test("refuses changed upstream structure rather than silently shipping a partial change", () => {
  assert.throws(() => brandPanel(fixture().replace("alt:'CPAMC logo'", "alt:'Unknown product'")), /logo/);
  assert.throws(() => brandPanel(fixture().replace("x-cpa-version", "unexpected-version-header")), /header/);
  assert.throws(() => brandPanel(fixture("var invalid = ;")), /JavaScript/);
  assert.throws(() => brandPanel("not an HTML dashboard"), /dashboard/);
});


test("removes project repository placeholders without changing configured URLs", () => {
  const repo = "https://github.com/router-for-me/Cli-Proxy-API-Management-Center";
  const result = brandPanel(fixture(`
var field={fieldId:'rmPanelRepo',placeholder:${JSON.stringify(repo)},value:${JSON.stringify(repo)}};
var quoted={'placeholder':'https://github.com/agentbeau/sub2api'};
var unrelated={placeholder:'https://provider.example/endpoint'};
`));
  const context = evaluate(result.html);
  assert.equal(context.field.placeholder, "");
  assert.equal(context.quoted.placeholder, "");
  assert.equal(context.field.value, repo);
  assert.equal(context.unrelated.placeholder, "https://provider.example/endpoint");
});
