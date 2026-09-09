import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { ANALYSIS_LIMITS, circularAnalysisGuards, analysisErrorHandler } from '../server/circularAnalysisGuard';
import { syncOptedInGoogleEvents } from '../src/services/googleCalendarService';
import type { CalendarEvent } from '../src/types';

const profile = { id:'test', fullName:'Docente', schoolName:'Scuola', schoolYear:'2027/2028', primarySubjects:[], classes:['1A'], campuses:[], roles:[] };
const payload = { text:'14 settembre 2027 Collegio docenti 15:00-17:00', profile };
const event: CalendarEvent = { id:'local', title:'Privato', date:'2027-09-14', startTime:'15:00', endTime:'16:00', isAllDay:false, category:'riunione', sourceType:'manuale' };

test('global sync sends only explicit opt-ins, including when a historical Google ID exists', async () => {
  const events = [event, {...event,id:'disabled',syncedWithGoogle:false,googleEventId:'old'}, {...event,id:'legacy',googleEventId:'legacy'}, {...event,id:'new',syncedWithGoogle:true}, {...event,id:'update',syncedWithGoogle:true,googleEventId:'remote'}];
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => { calls.push(`${options?.method} ${url}`); return new Response(JSON.stringify({id:'created'}),{status:200}); };
  try {
    const result = await syncOptedInGoogleEvents('token', events.map(e=>e.id), id=>events.find(e=>e.id===id), e=>{events[events.findIndex(x=>x.id===e.id)]=e;});
    assert.deepEqual(result,{syncedCount:2,errorCount:0});
    assert.equal(calls.length,2); assert.match(calls[0],/^POST /); assert.match(calls[1],/^PATCH .*remote$/);
    assert.equal(events[1].syncedWithGoogle,false);
  } finally { globalThis.fetch=original; }
});

test('revocation during sync stops queued updates and is preserved after an in-flight creation',async()=>{
  const events = [{...event,id:'first',syncedWithGoogle:true}, {...event,id:'next',syncedWithGoogle:true}];
  const original=globalThis.fetch; let calls=0;
  globalThis.fetch=async()=>{ calls++; events[0]={...events[0],title:'Edited',syncedWithGoogle:false};events[1].syncedWithGoogle=false;return new Response(JSON.stringify({id:'created'})); };
  try {
    await syncOptedInGoogleEvents('token',events.map(e=>e.id),id=>events.find(e=>e.id===id),e=>{Object.assign(events.find(x=>x.id===e.id)!,e);});
    assert.equal(calls,1); assert.equal(events[0].syncedWithGoogle,false);assert.equal(events[0].title,'Edited');
  }finally{globalThis.fetch=original;}
});

async function withEndpoint(run:(post:(body:unknown,raw?:boolean,headers?:Record<string,string>)=>Promise<Response>)=>Promise<void>, options = {}) {
  const app=express();
  app.post('/api/analyze-circular',...circularAnalysisGuards(options),(_req,res)=>res.json({success:true}));
  app.use(analysisErrorHandler);
  const server=app.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address() as {port:number};
  try { await run((body,raw=false,headers={})=>fetch(`http://127.0.0.1:${address.port}/api/analyze-circular`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:raw?String(body):JSON.stringify(body)})); }
  finally { await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }
}

for(const [name,body,status] of [
  ['oversized text',{...payload,text:'x'.repeat(ANALYSIS_LIMITS.textChars+1)},413],
  ['oversized file',{profile,mimeType:'application/pdf',imageBase64:Buffer.alloc(ANALYSIS_LIMITS.fileBytes+1).toString('base64')},413],
  ['unsupported MIME',{...payload,mimeType:'text/html'},415],
  ['malformed profile',{...payload,profile:{classes:'1A'}},400],
  ['missing content',{profile},400],
  ['invalid base64',{profile,mimeType:'application/pdf',imageBase64:'***'},400],
  ['false PDF signature',{profile,mimeType:'application/pdf',imageBase64:Buffer.from('not a pdf').toString('base64')},400],
  ['valid text',payload,200],
  ['valid PDF envelope',{profile,mimeType:'application/pdf',imageBase64:Buffer.from('%PDF-1.7\n').toString('base64')},200],
] as const) test(`analysis endpoint: ${name}`,async()=>withEndpoint(async post=>{assert.equal((await post(body)).status,status);}));

test('malformed JSON and global body limit return sanitized errors',async()=>withEndpoint(async post=>{
  const bad=await post('{"secretDocument":',true);assert.equal(bad.status,400);assert.doesNotMatch(await bad.text(),/secretDocument|SyntaxError/);
  const big=await post('x'.repeat(ANALYSIS_LIMITS.jsonBytes+1),true);assert.equal(big.status,413);
}));

test('rate limit ignores forged forwarding headers and resets after its window',async()=>{
  let now=0;
  await withEndpoint(async post=>{
    assert.equal((await post(payload)).status,200);
    const blocked=await post(payload,false,{'X-Forwarded-For':'1.2.3.4'});assert.equal(blocked.status,429);assert.equal(blocked.headers.get('Retry-After'),'60');
    now=60_001;assert.equal((await post(payload)).status,200);
  },{perIp:1,now:()=>now});
});

test('real endpoint retains text parser fallback without an API key',async()=>{
  const previous=process.env.GEMINI_API_KEY;delete process.env.GEMINI_API_KEY;
  const {app}=await import('../server');
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/analyze-circular`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    assert.equal(response.status,200);const result=await response.json();assert.equal(result.source,'local-heuristic');assert.equal(result.items[0].date,'2027-09-14');assert.equal(result.items[0].startTime,'15:00');assert.equal(result.items[0].endTime,'17:00');
  }finally{if(previous!==undefined)process.env.GEMINI_API_KEY=previous;await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
