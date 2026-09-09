import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { create, act } from 'react-test-renderer';
import { AgendaDatabase, database } from '../src/services/db';
import { demoInstallation, initializeStorage, storage } from '../src/services/storage';
import { observeLocalData, retainEqual } from '../src/services/observeLocalData';
import { persistenceErrorMessage } from '../src/services/persistenceErrors';
import { circularUploadError } from '../src/utils/circularUpload';
import { EventModal } from '../src/components/EventModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const legacy = {length:0,key:()=>null,getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
const seed=demoInstallation();
function signal<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
async function until<T>(promise:Promise<T>):Promise<T> {let timer:ReturnType<typeof setTimeout>;try{return await Promise.race([promise,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Notification timeout')),1500);})]);}finally{clearTimeout(timer!);}}
async function pair(run:(writer:AgendaDatabase,reader:AgendaDatabase)=>Promise<void>){const name=`beta-${crypto.randomUUID()}`,writer=new AgendaDatabase(name),reader=new AgendaDatabase(name);try{await writer.initialize(seed,legacy);await reader.initialize(seed,legacy);await run(writer,reader);}finally{writer.close();reader.close();await writer.delete();}}

test('multi-tab observer receives committed edits and deletions from another connection',async()=>pair(async(writer,reader)=>{
 const initial=signal<void>(),change=signal<void>(),removed=signal<void>();
 const stop=observeLocalData(reader,data=>{initial.resolve();if(data.profile.fullName==='Other tab')change.resolve();if(data.events.length===0)removed.resolve();},error=>{throw error;});
 try{await until(initial.promise);await writer.write('profile',{...seed.profile,fullName:'Other tab'});await until(change.promise);await writer.write('events',[]);await until(removed.promise);}finally{stop();}
}));

test('multi-tab restore publishes only coherent snapshots and rejected writes publish no partial state',async()=>pair(async(writer,reader)=>{
 const snapshots:any[]=[];const initial=signal<void>(),restored=signal<void>();
 const stop=observeLocalData(reader,data=>{snapshots.push(data);initial.resolve();if(data.profile.fullName==='Restored')restored.resolve();},error=>{throw error;});
 try{
 await until(initial.promise);
 await assert.rejects(writer.atomic(async()=>{await writer.write('profile',{...seed.profile,fullName:'Partial'});throw new Error('Abort');}));
 await writer.restore({...seed,profile:{...seed.profile,fullName:'Restored'},events:[],students:[],timetableMode:'definitivo',onboardingCompleted:true});await until(restored.promise);
 assert.ok(snapshots.every(data=>data.profile.fullName===seed.profile.fullName||(data.profile.fullName==='Restored'&&data.events.length===0&&data.students.length===0&&data.timetableMode==='definitivo'&&data.onboardingCompleted)));
 }finally{stop();}
}));

test('observer cleanup stops callbacks and equal snapshots preserve editor prop identity',async()=>pair(async(writer,reader)=>{
 const first=signal<void>();let calls=0;const stop=observeLocalData(reader,()=>{calls++;first.resolve();},()=>{});
 await until(first.promise);stop();await writer.write('events',[]);await new Promise(r=>setTimeout(r,20));assert.equal(calls,1);
 assert.equal(retainEqual(seed.profile,structuredClone(seed.profile)),seed.profile);
 assert.notEqual(retainEqual(seed.profile,{...seed.profile,fullName:'Changed'}),seed.profile);
}));

test('browser back-forward cache temporary close preserves automatic reopening and read/write access',async()=>pair(async(writer)=>{
 writer.close({disableAutoOpen:false});assert.equal(writer.mode,'indexeddb');assert.deepEqual(await writer.read('profile'),seed.profile);
 await writer.write('events',[]);assert.deepEqual(await writer.read('events'),[]);
}));

test('quota errors are understandable and preserve the previous DB snapshot',async()=>pair(async(writer)=>{
 const fail=()=>{throw new DOMException('Device full','QuotaExceededError');};writer.table('events').hook('creating',fail);
 try {await assert.rejects(writer.write('events',seed.events),error=>{assert.match(persistenceErrorMessage(error),/Spazio.*esaurito/);return true;});}
 finally{writer.table('events').hook('creating').unsubscribe(fail);}
 assert.deepEqual(await writer.readSnapshot(),seed);
 assert.match(persistenceErrorMessage({name:'DatabaseClosedError'}),/non disponibile/);
}));

test('stale student editor retains newly added notes and rejects concurrently changed student details',async()=>{
 database.close();await database.delete();await initializeStorage(legacy);
 const baseline=(await storage.getStudents())[0];const note={...baseline.notes[0],id:'concurrent-note',content:'Other tab'};
 await storage.addStudentNote(baseline.id,note);await storage.saveStudent({...baseline,fullName:'Edited'},baseline);
 const latest=(await storage.getStudents())[0];assert.equal(latest.notes[0].id,note.id);
 await assert.rejects(storage.saveStudent({...baseline,fullName:'Stale'},baseline),/altra scheda/);
 database.close();await database.delete();
});

test('stale event editors cannot overwrite edits or resurrect an event deleted in another tab',async()=>{
 database.close();await database.delete();await initializeStorage(legacy);
 const baseline=(await storage.getEvents())[0];await storage.saveEvent({...baseline,title:'Other tab'});
 await assert.rejects(storage.saveEvent({...baseline,title:'Stale'},baseline),/altra scheda/);
 await storage.deleteEvent(baseline.id);await assert.rejects(storage.saveEvent(baseline,baseline),/altra scheda/);
 assert.ok(!(await storage.getEvents()).some(e=>e.id===baseline.id));database.close();await database.delete();
});

for(const [type,size,expected] of [['image/gif',100,/Formato/],['application/pdf',5*1024*1024+1,/5 MB/],['text/plain',400001,/100.000/]] as const)test(`upload rejects ${type} size ${size} before FileReader`,()=>assert.match(circularUploadError({name:'file',type,size})!,expected));
test('supported PDF/image/text inputs remain accepted',()=>{for(const type of ['application/pdf','image/png','image/jpeg','image/webp','text/plain'])assert.equal(circularUploadError({name:'file',type,size:100}),null);});

function button(root:any,text:string){return root.findAllByType('button').find((node:any)=>node.children.some((child:any)=>typeof child==='string'&&child.includes(text)));}
test('failed async event deletion keeps confirmation open and displays an error',async()=>{
 let closed=0,view:any;await act(async()=>{view=create(React.createElement(EventModal,{isOpen:true,eventToEdit:seed.events[0],profile:seed.profile,onClose:()=>{closed++;},onSave:()=>{},onDelete:async()=>false}));});
 try{
 const trigger=view.root.findAllByType('button').find((node:any)=>node.findAllByType('span').some((span:any)=>span.children.includes('Elimina impegno')));
 await act(async()=>trigger.props.onClick());await act(async()=>button(view.root,'Sì, elimina').props.onClick());
 assert.equal(closed,0);assert.ok(button(view.root,'Sì, elimina'));assert.ok(view.root.findAllByProps({role:'alert'}).length>0);
 }finally{await act(async()=>view.unmount());}
});

test('event draft survives another tab changing profile and event save waits for commit',async()=>{
 let closed=0,view:any;const deferred=signal<void>();const props={isOpen:true,eventToEdit:seed.events[0],profile:seed.profile,onClose:()=>{closed++;},onSave:()=>deferred.promise};
 await act(async()=>{view=create(React.createElement(EventModal,props));});
 try{
 const title=view.root.findAllByType('input').find((node:any)=>node.props.value===seed.events[0].title);
 await act(async()=>title.props.onChange({target:{value:'Unsaved draft'}}));
 await act(async()=>view.update(React.createElement(EventModal,{...props,profile:{...seed.profile,fullName:'Other tab'}})));
 assert.ok(view.root.findAllByType('input').some((node:any)=>node.props.value==='Unsaved draft'));
 let pending:Promise<void>;await act(async()=>{pending=view.root.findByType('form').props.onSubmit({preventDefault(){}});});assert.equal(closed,0);
 await act(async()=>{deferred.resolve();await pending!;});assert.equal(closed,1);
 }finally{await act(async()=>view.unmount());}
});

import { restoreAndRefresh } from '../src/services/restoreWorkflow';
import { deleteEventLocallyFirst } from '../src/services/eventWorkflows';
import { syncOptedInGoogleEvents } from '../src/services/googleCalendarService';

test('a committed restore with failed view refresh is never reported as a failed restore',async()=>{
 let calls=0;const message=await restoreAndRefresh('{"version":3}',async()=>{calls++;return true;},async()=>false as const);
 assert.equal(calls,1);assert.match(message,/ripristinato correttamente/);assert.match(message,/non ripetere/);
 let refreshed=false;assert.match(await restoreAndRefresh('{}',async()=>false,()=>{refreshed=true;}),/non riuscito/);assert.equal(refreshed,false);
});

test('local deletion failure leaves the remote event untouched; remote failure does not undo local deletion',async()=>{
 database.close();await database.delete();await initializeStorage(legacy);
 const event={...seed.events[0],googleEventId:'remote',syncedWithGoogle:true};await storage.saveEvent(event);
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Offline');};
 const fail=()=>{throw new DOMException('Full','QuotaExceededError');};database.table('events').hook('creating',fail);
 try{await assert.rejects(deleteEventLocallyFirst(event.id,'token'));assert.equal(calls,0);}
 finally{database.table('events').hook('creating').unsubscribe(fail);}
 try {assert.equal(await deleteEventLocallyFirst(event.id,'token'),false);assert.equal(calls,1);assert.ok(!(await storage.getEvents()).some(e=>e.id===event.id));}
 finally{globalThis.fetch=previous;database.close();await database.delete();}
});

test('simultaneous Google sync requests serialize and cannot create duplicate remote events',async()=>{
 let event={...seed.events[0],syncedWithGoogle:true};let creates=0;const previous=globalThis.fetch;
 globalThis.fetch=async(_url,options)=>{if(options?.method==='POST')creates++;return new Response(JSON.stringify({id:'remote'}));};
 try {const args: Parameters<typeof syncOptedInGoogleEvents> = ['token',[event.id],()=>event,(updated:any)=>{event=updated;}];
 await Promise.all([syncOptedInGoogleEvents(...args),syncOptedInGoogleEvents(...args)]);assert.equal(creates,1);}
 finally{globalThis.fetch=previous;}
});

import { SCOPES } from '../src/services/googleAuth';
test('Google login requests the events permission needed by primary-calendar writes, without full-calendar access',()=>{
 assert.ok(SCOPES.includes('https://www.googleapis.com/auth/calendar.events.owned'));
 assert.ok(!SCOPES.includes('https://www.googleapis.com/auth/calendar'));
});

test('profile and both timetable editors reject stale saves without overwriting another tab',async()=>{
 database.close();await database.delete();await initializeStorage(legacy);
 const profile=await storage.getProfile();await storage.saveProfile({...profile,fullName:'Other tab'});
 await assert.rejects(storage.saveProfile(profile,profile),/altra scheda/);
 for(const type of ['provvisorio','definitivo'] as const){
 const slot={...seed.provisionalTimetable[0],id:`slot-${type}`};await storage.saveTimetableSlot(slot,type);
 await storage.saveTimetableSlot({...slot,subject:'Changed elsewhere'},type);
 await assert.rejects(storage.saveTimetableSlot(slot,type,{...slot,isProvisional:type==='provvisorio'}),/altra scheda/);
 }
 database.close();await database.delete();
});
