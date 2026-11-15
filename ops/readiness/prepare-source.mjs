// Host-side preparation only: pinned public source and checksum-verified dependencies.
// Docker RUN stages need no network. No credentials or checkout .git enter the context.
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const providerCommit='8bba7a77c6bcbfd993516d26606bfecaa4ff49d0';
const goSHA='ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5';
export async function prepareSource(root=process.cwd()) {
  const staging=mkdtempSync(join(tmpdir(),'gateway-readiness-'));
  try {
  const context=join(staging,'context'), source=join(context,'source'), checkout=join(staging,'checkout');
  const run=(c,a,options={})=>execFileSync(c,a,{stdio:'inherit',...options});
  mkdirSync(context); mkdirSync(checkout);
  // A local archive override is useful in restricted runners, but never skips checksum verification.
  const archive=join(staging,'go.tar.gz');
  if(process.env.READINESS_GO_ARCHIVE) cpSync(process.env.READINESS_GO_ARCHIVE,archive);
  else {
    const r=await fetch('https://go.dev/dl/go1.26.10.linux-amd64.tar.gz');
    if(!r.ok)throw Error(`Official Go download HTTP ${r.status}`);
    writeFileSync(archive,Buffer.from(await r.arrayBuffer()));
  }
  if(createHash('sha256').update(readFileSync(archive)).digest('hex')!==goSHA)throw Error('Official Go archive checksum mismatch');
  run('tar',['-xzf',archive,'-C',staging]);
  const go=join(staging,'go/bin/go');
  run('git',['init','-q',checkout]);
  run('git',['-C',checkout,'remote','add','origin','https://github.com/router-for-me/CLIProxyAPI.git']);
  run('git',['-C',checkout,'fetch','--depth','1','origin',providerCommit]);
  run('git',['-C',checkout,'checkout','--detach',providerCommit]);
  if(execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==providerCommit)throw Error('Provider commit mismatch');
  mkdirSync(source);
  const tar=join(staging,'source.tar');
  run('git',['-C',checkout,'archive','--format=tar',`--output=${tar}`,providerCommit]);
  run('tar',['-xf',tar,'-C',source]);
  const originalMod=readFileSync(join(source,'go.mod')),originalSum=readFileSync(join(source,'go.sum'));
  const env={...process.env,GOCACHE:join(staging,'go-cache'),GOPATH:process.env.GOPATH||join(staging,'go-path'),GOTOOLCHAIN:'local',GOFLAGS:'-mod=readonly',GOSUMDB:'sum.golang.org',GOPROXY:'https://proxy.golang.org',GOPRIVATE:'',GONOSUMDB:'',GONOPROXY:''};
  run(go,['mod','download'],{cwd:source,env});
  run(go,['mod','verify'],{cwd:source,env});
  run(go,['mod','vendor'],{cwd:source,env});
  if(!originalMod.equals(readFileSync(join(source,'go.mod')))||!originalSum.equals(readFileSync(join(source,'go.sum'))))throw Error('Pinned module manifests unexpectedly changed');
  cpSync(join(root,'container'),join(context,'container'),{recursive:true});
  writeFileSync(join(context,'preparation.json'),JSON.stringify({providerCommit,goVersion:'1.26.10',goSHA,goSumSHA:createHash('sha256').update(originalSum).digest('hex')})+'\n');
  return {staging,context,cleanup:()=>rmSync(staging,{recursive:true,force:true})};
  } catch(error) { rmSync(staging,{recursive:true,force:true}); throw error; }
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const p=await prepareSource(); console.log(`PREPARED_CONTEXT=${p.context}`);
}
