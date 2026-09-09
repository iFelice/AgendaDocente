import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serverPort } from '../server';
import { firebaseOptions } from '../src/services/firebaseConfig';

const root = process.cwd();
test('PORT environment is honored, local fallback only; invalid production config rejected', () => {
  assert.equal(serverPort({PORT:'4321', NODE_ENV:'production'}),4321);
  assert.equal(serverPort({NODE_ENV:'development'}),3000);
  for (const PORT of [undefined,'0','65536','abc','3000oops']) {
    assert.throws(() => serverPort({PORT,NODE_ENV:'production'}),/PORT/);
  }
});
test('Firebase configuration is optional and uses only explicit public fields', () => {
  assert.equal(firebaseOptions({}),null);
  assert.equal(firebaseOptions({VITE_FIREBASE_API_KEY:'public-key'}),null);
  assert.deepEqual(firebaseOptions({VITE_FIREBASE_API_KEY:'public-key',VITE_FIREBASE_AUTH_DOMAIN:'example.firebaseapp.com',VITE_FIREBASE_PROJECT_ID:'example',VITE_FIREBASE_APP_ID:'example-app',GEMINI_API_KEY:'secret-sentinel'}),{
    apiKey:'public-key',authDomain:'example.firebaseapp.com',projectId:'example',appId:'example-app',
  });
});
test('production starts on PORT: health, SPA/assets, API isolation and no exposed server bundle', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'agenda-deploy-'));
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0,'127.0.0.1',resolve));
  const port = (probe.address() as {port:number}).port;
  await new Promise<void>(resolve => probe.close(()=>resolve()));
  await mkdir(path.join(dir,'dist'));
  for (const [name,content] of Object.entries({'index.html':'<!doctype html><title>Agenda fixture</title>','asset.js':'export const ok=true;','manifest.webmanifest':'{"name":"Agenda"}','sw.js':'/* worker */','server.cjs':'internal','server.cjs.map':'internal map'})) await writeFile(path.join(dir,'dist',name),content);
  const child = spawn(process.execPath,['--import',path.join(root,'node_modules/tsx/dist/loader.mjs'),path.join(root,'server.ts')],{cwd:dir,env:{...process.env,NODE_ENV:'production',PORT:String(port),GEMINI_API_KEY:''},stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const exited = new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  try {
    await new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>{clearInterval(poll);reject(new Error('Startup timeout: '+output));},15000);
      const poll=setInterval(()=>{if(output.includes('server attivo')){clearInterval(poll);clearTimeout(timeout);resolve();}else if(child.exitCode!==null){clearInterval(poll);clearTimeout(timeout);reject(new Error(output));}},25);
    });
    const get=(route:string)=>fetch(`http://127.0.0.1:${port}${route}`);
    const health=await get('/api/health');assert.equal(health.status,200);assert.deepEqual(await health.json(),{status:'ok'});
    for(const route of ['/','/planning/week']){const r=await get(route);assert.equal(r.status,200);assert.match(await r.text(),/Agenda fixture/);}
    for(const route of ['/asset.js','/manifest.webmanifest','/sw.js'])assert.equal((await get(route)).status,200);
    for(const route of ['/api/missing','/api/analyze-circular']){const r=await get(route);assert.equal(r.status,404);assert.match(r.headers.get('content-type')!,/json/);}
    for(const route of ['/server.cjs','/server.cjs.map','/server.%63js'])assert.equal((await get(route)).status,404);
    const profile={id:'test',fullName:'Test',schoolName:'Test',schoolYear:'2026/2027',primarySubjects:[],classes:[],campuses:[],roles:[]};
    const analyze=(payload:object)=>fetch(`http://127.0.0.1:${port}/api/analyze-circular`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,profile})});
    const text=await analyze({text:'15 settembre 2026 Collegio docenti 15:00-17:00'});assert.equal(text.status,200);assert.equal((await text.json()).source,'local-heuristic');
    const pdf=await analyze({imageBase64:Buffer.from('%PDF-test').toString('base64'),mimeType:'application/pdf'});assert.equal(pdf.status,503);assert.match((await pdf.json()).error,/non disponibile/);
  } finally {child.kill();await exited;await rm(dir,{recursive:true,force:true});}
});
test('PWA navigation fallback excludes API paths',async()=>{
  const source=await readFile(path.join(root,'vite.config.ts'),'utf8');
  assert.ok(source.includes('navigateFallbackDenylist: [/^\\/api(?:\\/|$)/]'));
});
