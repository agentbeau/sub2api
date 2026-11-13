import { describe,it,expect,vi } from "vitest";
import {classifyEffort,clefInput,chooseEffort, type ClassifierOptions} from "../src/effort-classifier.ts";
const result={answers:{effort:{choice:"low",probabilities:{low:.95,medium:.03,high:.02},confidence:.3}}};
const options=():ClassifierOptions=>({supported:{"verified-model":["low","medium","high"]},reserve:vi.fn(async()=>true),decide:vi.fn(async()=>result),waitUntil:()=>{}});
const req=(body:unknown,path="/v1/chat/completions")=>new Request("https://preview.example"+path,{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer synthetic-secret"},body:JSON.stringify(body)});
const body=()=>({model:"verified-model",messages:[{role:"system",content:"NEVER_CLASSIFY_SYSTEM"},{role:"user",content:"What is 2+3?"}],tools:[{type:"function",function:{name:"keep_me"}}],metadata:{keep:"all"},stream:true});
describe("preview effort classification",()=>{
 it("only changes effort; preserves instructions/tools/history; never sends headers",async()=>{const b=body(),o=options(),r=req(b);const out=await classifyEffort(r,o);expect(await out.json()).toEqual({...b,reasoning_effort:"low"});expect(o.decide).toHaveBeenCalledWith("What is 2+3?");expect(out.headers.get("authorization")).toBe("Bearer synthetic-secret");expect(await r.json()).toEqual(b);expect(JSON.stringify(clefInput("x"))).not.toContain("synthetic-secret");});
 for(const explicit of ["high",null,""]){it(`preserves explicit ${explicit}`,async()=>{const r=req({...body(),reasoning_effort:explicit}),o=options();expect(await classifyEffort(r,o)).toBe(r);expect(o.decide).not.toHaveBeenCalled();});}
 it("preserves native Responses instructions and reasoning summary",async()=>{const b={model:"verified-model",input:"Say hello",instructions:"keep",reasoning:{summary:"auto"}},o=options();expect(await (await classifyEffort(req(b,"/v1/responses"),o)).json()).toEqual({...b,reasoning:{summary:"auto",effort:"low"}});});
 it("bypasses existing Responses effort",async()=>{const r=req({model:"verified-model",input:"x",reasoning:{effort:"high"}},"/v1/responses"),o=options();expect(await classifyEffort(r,o)).toBe(r);expect(o.reserve).not.toHaveBeenCalled();});
 for(const b of [{...body(),model:"unknown"},{...body(),messages:[{role:"user",content:"x"},{role:"tool",content:"secret"}]},{...body(),messages:[{role:"user",content:"x".repeat(2049)}]},{...body(),messages:[{role:"user",content:[{type:"image_url",image_url:{url:"secret"}}]}]}]){it("skips unsupported/ambiguous/content-heavy inputs",async()=>{const r=req(b),o=options();expect(await classifyEffort(r,o)).toBe(r);expect(o.decide).not.toHaveBeenCalled();});}
 it("budget exhaustion leaves request unchanged",async()=>{const o={...options(),reserve:async()=>false};const r=req(body());expect(await classifyEffort(r,o)).toBe(r);expect(o.decide).not.toHaveBeenCalled();});
 it("timeout leaves original and makes one call",async()=>{const o={...options(),decide:vi.fn(()=>new Promise(()=>{})),timeoutMs:1};const r=req(body());expect(await classifyEffort(r,o)).toBe(r);expect(o.decide).toHaveBeenCalledTimes(1);});
 it("rejects uncertain/unsupported decisions",()=>{expect(chooseEffort(result,["high"])).toBeUndefined();expect(chooseEffort({answers:{effort:{choice:"high",probabilities:{high:.73}}}},["high"])).toBeUndefined();});
 it("only supported inference endpoints",async()=>{const o=options(),r=req(body(),"/v1/images/generations");expect(await classifyEffort(r,o)).toBe(r);expect(o.reserve).not.toHaveBeenCalled();});
 it("oversized body skips inference",async()=>{const o=options(),r=req({...body(),metadata:{huge:"x".repeat(66000)}});expect(await classifyEffort(r,o)).toBe(r);expect(o.reserve).not.toHaveBeenCalled();});
});

describe("fail-safe request preservation",()=>{
 it("slow body does not block forwarding indefinitely",async()=>{
  const stream = new ReadableStream<Uint8Array>({start(){}});
  const r = new Request("https://preview.example/v1/responses",{method:"POST",headers:{"content-type":"application/json"},body:stream,duplex:"half"} as RequestInit);
  const o=options();const start=Date.now();expect(await classifyEffort(r,o)).toBe(r);expect(Date.now()-start).toBeLessThan(1000);expect(o.decide).not.toHaveBeenCalled();
 });
 it("malformed body remains original bytes",async()=>{const r=new Request("https://preview.example/v1/responses",{method:"POST",headers:{"content-type":"application/json"},body:'{ bad  json'});expect(await classifyEffort(r,options())).toBe(r);expect(await r.text()).toBe('{ bad  json');});
 it("low confidence, budget failure and model errors keep full original body",async()=>{for(const o of [{...options(),decide:async()=>({})},{...options(),reserve:async()=>{throw new Error('storage unavailable');}},{...options(),decide:async()=>{throw new Error('AI unavailable');}}]){const b=body(),r=req(b);expect(await classifyEffort(r,o)).toBe(r);expect(await r.json()).toEqual(b);}});
});

describe("review regression checks",()=>{
 it("does not call Clef for inherited model names",async()=>{for(const model of ['constructor','toString','__proto__']){const o=options(),r=req({...body(),model});expect(await classifyEffort(r,o)).toBe(r);expect(o.decide).not.toHaveBeenCalled();}});
 it("preserves large integers and whitespace in original payload",async()=>{const raw=' { "model":"verified-model", "input":"Add 5 and 9", "metadata":{"id":9007199254740993}, "reasoning": { "summary":"auto" } }  ';const r=new Request('https://preview.example/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:raw});const out=await(await classifyEffort(r,options())).text();expect(out).toBe(' { "model":"verified-model", "input":"Add 5 and 9", "metadata":{"id":9007199254740993}, "reasoning": { "summary":"auto" ,"effort":"low"} }  ');});
 it("skips ambiguous short continuations",async()=>{for(const content of ['yes','continue','do it','again!']){const o=options(),r=req({...body(),messages:[{role:'user',content}]});expect(await classifyEffort(r,o)).toBe(r);expect(o.decide).not.toHaveBeenCalled();}});
});

it("bypasses duplicate top-level keys before any AI call",async()=>{for(const raw of ['{"model":"verified-model","input":"Calculate 2+2","reasoning":{},"reasoning":{"summary":"auto"}}','{"model":"unknown","model":"verified-model","input":"Calculate 2+2"}']){const r=new Request('https://preview.example/v1/responses',{method:'POST',headers:{'content-type':'application/json'},body:raw}),o=options();expect(await classifyEffort(r,o)).toBe(r);expect(o.decide).not.toHaveBeenCalled();expect(await r.text()).toBe(raw);}});
