export const PANEL_KEY = "dashboard/management.html";

const SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>sub2api · Provider controls</title><style>
:root{font-family:system-ui,sans-serif;color:#e9edf2;background:#10151c;color-scheme:dark}*{box-sizing:border-box}
body{margin:0}main{max-width:1000px;margin:48px auto;padding:0 24px}header{display:flex;justify-content:space-between;align-items:center;gap:16px}
h1{font-size:28px;letter-spacing:-.5px;margin:8px 0}p{line-height:1.6;color:#b5c1d0;max-width:760px}.card{background:#19222e;border:1px solid #344253;border-radius:16px;padding:24px;margin:28px 0}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0 8px}button,a{font:inherit}button{border:1px solid #526279;border-radius:9px;padding:11px 17px;cursor:pointer;background:#27364a;color:white}
button.primary{background:#b5f0ce;color:#11261d;border-color:#b5f0ce}button:disabled{opacity:.5;cursor:wait}a{color:#b5f0ce}#status{font-weight:600;color:#e9edf2}#error{color:#ffb7b7;white-space:pre-wrap}iframe{width:100%;height:82vh;border:0;background:white;display:none}body.controls main{margin:20px auto}body.controls .intro{display:none}
</style></head><body><main><header><h1>sub2api</h1><a href="/logout">Sign out</a></header>
<p class="intro">Your gateway is ready for model requests. Opening this page leaves the provider container asleep.</p>
<section class="card"><div id="status" role="status">Checking provider status…</div>
<p>Start controls to connect a provider or change settings. Controls stay open for two minutes; use Extend controls to keep editing. Model requests wake the provider automatically.</p>
<div class="actions"><button class="primary" id="start">Start controls</button><button id="close" hidden>Close controls</button><button id="refresh">Refresh status</button></div>
<p id="error" role="alert"></p><p>Closing controls releases this editing window. Active model responses, provider sign-ins and saving work continue.</p></section></main>
<iframe id="panel" title="Provider management controls" referrerpolicy="same-origin"></iframe>
<script>
const statusEl=document.getElementById('status'), errorEl=document.getElementById('error'), start=document.getElementById('start'), close=document.getElementById('close'), panel=document.getElementById('panel');
let opened=false, timer, expiry;
function hide(){opened=false;clearTimeout(timer);clearTimeout(expiry);panel.removeAttribute('src');panel.style.display='none';document.body.classList.remove('controls');close.hidden=true;start.textContent='Start controls';}
async function call(path,method='GET'){const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',...(method==='POST'?{headers:{'content-type':'application/json'},body:'{}'}:{})});if(response.status===401){location.assign('/login');throw new Error('Please sign in again.');}const value=await response.json();if(!response.ok)throw new Error(value.error?.message||'Provider controls are unavailable. Try again.');return value;}
function show(value){statusEl.textContent=value.running?'Provider is running':'Provider is asleep';if(opened){if(!value.running||value.controls_remaining_ms<=0){hide();return;}statusEl.textContent+=' · controls close in '+Math.ceil(value.controls_remaining_ms/1000)+' seconds';clearTimeout(expiry);expiry=setTimeout(()=>{hide();void refresh();},value.controls_remaining_ms);clearTimeout(timer);timer=setTimeout(()=>void refresh(),10000);}}
async function refresh(){try{show(await call('/runtime/status'));}catch(error){errorEl.textContent=error.message;}}
start.addEventListener('click',async()=>{start.disabled=true;errorEl.textContent='';try{const value=await call('/runtime/start','POST');if(!value.running)throw new Error('The provider has not started. Try again.');if(!opened){opened=true;panel.src='/provider-panel.html';panel.style.display='block';document.body.classList.add('controls');}close.hidden=false;start.textContent='Extend controls';show(value);}catch(error){errorEl.textContent=error.message;}finally{start.disabled=false;}});
close.addEventListener('click',async()=>{hide();errorEl.textContent='';try{show(await call('/runtime/stop','POST'));}catch(error){errorEl.textContent=error.message;}});
document.getElementById('refresh').addEventListener('click',()=>void refresh());void refresh();
</script></body></html>`;

export function methodNotAllowed(allow: string): Response {
  return Response.json({ error: { message: "Method not allowed." } }, { status: 405, headers: { allow, "cache-control": "no-store" } });
}

// Call after the Rust session gate. Both HTML responses come from the edge; the
// provider panel is exactly the checked build artifact, never fetched from CPA.
export async function serveDashboard(request: Request, store: Pick<R2Bucket, "get">): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
  const shell = new URL(request.url).pathname === "/management.html";
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "same-origin",
    "x-frame-options": shell ? "DENY" : "SAMEORIGIN",
    "content-security-policy": shell
      ? "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
      : "frame-ancestors 'self'; base-uri 'self'",
  });
  if (shell) return new Response(request.method === "HEAD" ? null : SHELL, { headers });
  try {
    const object = await store.get(PANEL_KEY);
    if (object === null) throw new Error("Panel is not provisioned");
    headers.set("etag", object.httpEtag);
    if (request.method === "HEAD") {
      void object.body.cancel().catch(() => {});
      return new Response(null, { headers });
    }
    return new Response(object.body, { headers });
  } catch {
    return Response.json({ error: { message: "The dashboard bundle is unavailable. Check the deployment's dashboard artifact." } }, {
      status: 503, headers: { "cache-control": "no-store" },
    });
  }
}
