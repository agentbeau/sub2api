// One-off enhanced image build. Does not deploy a Worker, change configuration, or update a container app.
import {execFileSync,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const run=(c,a,options={})=>execFileSync(c,a,{stdio:'inherit',...options});
const capture=(c,a)=>execFileSync(c,a,{encoding:'utf8'}).trim();
const account='c05a228a4bebdc8625e8f42d405475a7';
const revision=capture('git',['rev-parse','HEAD']);
if(!/^[a-f0-9]{40}$/.test(revision)||revision!==process.env.WORKERS_CI_COMMIT_SHA)throw Error('Exact checkout/build commit required');
if(capture('git',['status','--porcelain','--untracked-files=no']))throw Error('Tracked source modified');
const token=process.env.CLOUDFLARE_API_TOKEN;
if(!token)throw Error('Existing Cloudflare build credential required');
const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/containers/registries/registry.cloudflare.com/credentials`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({expiration_minutes:15,permissions:['pull','push']})});
if(!response.ok)throw Error(`Registry authorization status ${response.status}`);
const data=await response.json();const credentials=data.result||data;
if(!credentials.username||!credentials.password)throw Error('Registry credentials missing');
const login=spawnSync('docker',['login','--password-stdin','--username',credentials.username,'registry.cloudflare.com'],{input:credentials.password,stdio:['pipe','pipe','pipe'],encoding:'utf8'});
if(login.status!==0)throw Error('Registry login failed');
const tag=`gateway-readiness:${revision.slice(0,12)}`;
try{
 run('docker',['version']);
 run('docker',['build','--pull','--platform','linux/amd64','-f','ops/readiness/Dockerfile','--label',`org.opencontainers.image.revision=${revision}`,'-t',tag,'.']);
 const imageId=capture('docker',['image','inspect','--format','{{.Id}}',tag]);
 run('sh',['test/container-smoke.sh','--prebuilt'],{env:{...process.env,IMAGE:tag}});
 run('node_modules/.bin/wrangler',['containers','push',tag]);
 const remote=`registry.cloudflare.com/${account}/${tag}`;
 const digests=JSON.parse(capture('docker',['image','inspect','--format','{{json .RepoDigests}}',remote]));
 console.log('VERIFIED_BUILD_RECEIPT '+JSON.stringify({revision,imageId,digests,providerCommit:'8bba7a77c6bcbfd993516d26606bfecaa4ff49d0',baseImage:'sha256:6a8959018529d6d505278eae7e346d550fbd511da3ba069d7be11871a05a47f1',tests:'container-smoke passed',deployed:false}));
}finally{spawnSync('docker',['logout','registry.cloudflare.com'],{stdio:'ignore'});}
