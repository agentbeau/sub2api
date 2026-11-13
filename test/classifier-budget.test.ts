import {describe,it,expect} from "vitest";
import {reserveClassification} from "../src/classifier-budget.ts";
function store(){const map=new Map<string,unknown>();return {transaction:async<T>(f:(t:{get<T>(k:string):Promise<T|undefined>;put(k:string,v:unknown):Promise<void>})=>Promise<T>)=>f({get:async<T>(k:string)=>map.get(k) as T|undefined,put:async(k,v)=>{map.set(k,v);}})};}
describe("persistent classifier budget",()=>{
 it("caps minute, preserves daily cap across instances",async()=>{const s=store(),day=20000*86400000;for(let m=0;m<10;m++){for(let n=0;n<10;n++)expect(await reserveClassification(s,day+m*60000)).toBe(true);expect(await reserveClassification(s,day+m*60000)).toBe(false);}expect(await reserveClassification(s,day+11*60000)).toBe(false);expect(await reserveClassification(s,day+86400000)).toBe(true);});
 it("fails closed for clock rollback",async()=>{const s=store();expect(await reserveClassification(s,120000)).toBe(true);expect(await reserveClassification(s,60000)).toBe(false);});
});
