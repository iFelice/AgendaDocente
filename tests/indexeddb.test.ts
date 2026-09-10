import 'fake-indexeddb/auto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import { AgendaDatabase, LEGACY_KEYS, readLegacyData, type LegacyStorage, type LocalData, exportLegacyData } from '../src/services/db';
import { demoInstallation } from '../src/services/storage';
import { normalizeSchoolLinkedData } from '../src/utils/multiSchool';
const migrated = (data: LocalData) => normalizeSchoolLinkedData(data);

function legacy(data?: LocalData) {
  const values = new Map<string,string>();
  if (data) for (const [field,key] of Object.entries(LEGACY_KEYS)) {
    const value = data[field as keyof LocalData];
    values.set(key, field === 'timetableMode' ? String(value) : JSON.stringify(value));
  }
  const store: LegacyStorage = {
    get length(){return values.size;}, key:i=>[...values.keys()][i] ?? null,
    getItem:key=>values.get(key) ?? null, setItem:(key,value)=>{values.set(key,value);}, removeItem:key=>{values.delete(key);},
  };
  return {values,store};
}
function realData(): LocalData {
  const data=demoInstallation();
  data.profile={...data.profile,id:'real-teacher',fullName:'Docente reale',schoolYear:'2027/2028'};
  data.events=[{...data.events[0],id:'real-event',sourceType:'circolare',sourceCircularId:'real-circular',sourceItemId:'item',googleEventId:'remote',syncedWithGoogle:false}];
  data.circulars=[{id:'real-circular',title:'Originale',fileName:'originale.txt',fileType:'text',uploadDate:'2027-09-01',rawText:'Testo originale',extractedCount:1,relevantCount:1,
    extractedItems:[{tempId:'item',title:'Incontro',category:'glo',date:'2027-09-14',startTime:'15:00',endTime:'16:30',relevance:'VERDE',relevanceReason:'Classe docente',selectedForImport:true}]}];
  data.students=[{...data.students[0],id:'real-student',fullName:'Studente reale',notes:[{...data.students[0].notes[0],id:'real-note',content:'Nota da conservare'}]}];
  data.definitiveTimetable=[{...data.provisionalTimetable[0],id:'def',isProvisional:false}];
  data.provisionalTimetable=[{...data.provisionalTimetable[1],id:'prov'}];
  data.timetableMode='definitivo'; data.onboardingCompleted=true;
  return data;
}
async function withDB(run:(db:AgendaDatabase)=>Promise<void>) {
  const db=new AgendaDatabase(`test-${crypto.randomUUID()}`);
  try {await run(db);} finally {db.close();await db.delete();}
}

test('new installation seeds once, with separate entity records and a committed migration version',async()=>withDB(async db=>{
  const empty=legacy();const seed=demoInstallation();await db.initialize(seed,empty.store);
  assert.deepEqual(await db.readSnapshot(),seed);
  assert.equal(await db.table('events').count(),seed.events.length);
  assert.equal((await db.table('metadata').get('migration')).value,1);
  await db.write('events',[]);db.close();await db.initialize(seed,empty.store);
  assert.deepEqual(await db.read('events'),[]);assert.equal(empty.values.size,0);
}));

test('complete legacy migration preserves every collection, field, ID and source data',async()=>withDB(async db=>{
  const data=realData(), old=legacy(data), original=exportLegacyData(old.store);
  await db.initialize(demoInstallation(),old.store);
  assert.equal(db.mode,'indexeddb');assert.deepEqual(await db.readSnapshot(),migrated(data));
  assert.equal(exportLegacyData(old.store),original);
  assert.equal((await db.read('events'))[0].sourceCircularId,'real-circular');
  assert.equal((await db.read('events'))[0].sourceItemId,'item');
  assert.equal((await db.read('events'))[0].googleEventId,'remote');
  assert.equal((await db.read('students'))[0].notes[0].content,'Nota da conservare');
  assert.equal((await db.read('definitiveTimetable'))[0].id,'def');
  assert.equal((await db.read('provisionalTimetable'))[0].id,'prov');
  assert.equal(await db.read('timetableMode'),'definitivo');assert.equal(await db.read('onboardingCompleted'),true);
}));

test('migration is idempotent across connections and never overwrites newer DB with stale or corrupt legacy',async()=>withDB(async db=>{
  const old=legacy(realData());await db.initialize(demoInstallation(),old.store);
  const latest={...realData().profile,fullName:'Modifica recente'};await db.write('profile',latest);await db.write('events',[]);
  db.close();old.values.set(LEGACY_KEYS.profile,'broken JSON');
  await db.initialize(demoInstallation(),old.store);
  assert.equal(db.mode,'indexeddb');assert.deepEqual(await db.read('profile'),latest);assert.deepEqual(await db.read('events'),[]);
}));

test('valid populated database without marker takes precedence over old localStorage',async()=>withDB(async db=>{
  const old=legacy(realData());await db.initialize(demoInstallation(),old.store);
  await db.write('profile',{...realData().profile,fullName:'Newer'});
  await db.table('metadata').delete('migration');db.close();await db.initialize(demoInstallation(),old.store);
  assert.equal((await db.read('profile')).fullName,'Newer');assert.equal((await db.table('metadata').get('migration')).value,1);
}));

for(const phase of ['events','metadata']) test(`interruption at ${phase} rolls back all migration writes and can restart after refresh`,async()=>withDB(async db=>{
  const old=legacy(realData()), original=exportLegacyData(old.store);
  const abort=(_key:unknown,value:any)=>{ if(phase==='events'||value.key==='migration') Dexie.currentTransaction!.abort(); };
  db.table(phase).hook('creating',abort);
  await db.initialize(demoInstallation(),old.store);
  assert.equal(db.mode,'legacy-readonly');assert.deepEqual(await db.readSnapshot(),migrated(realData()));
  for(const table of db.tables)assert.equal(await table.count(),0);
  assert.equal(exportLegacyData(old.store),original);
  await assert.rejects(db.write('events',[]),/sola lettura/);
  db.table(phase).hook('creating').unsubscribe(abort);db.close();
  await db.initialize(demoInstallation(),old.store);
  assert.equal(db.mode,'indexeddb');assert.deepEqual(await db.readSnapshot(),migrated(realData()));
}));

test('quota failure during migration retains a read-only legacy copy and no partially migrated records',async()=>withDB(async db=>{
  const old=legacy(realData()), original=exportLegacyData(old.store);
  const fail=()=>{throw new DOMException('Full','QuotaExceededError');};db.table('students').hook('creating',fail);
  await db.initialize(demoInstallation(),old.store);
  assert.equal(db.mode,'legacy-readonly');assert.deepEqual(await db.read('students'),realData().students);
  assert.equal(await db.table('profile').count(),0);assert.equal(exportLegacyData(old.store),original);
  db.table('students').hook('creating').unsubscribe(fail);
}));

test('DB unavailable can still expose validated legacy offline, without permitting edits',async()=>withDB(async db=>{
  const originalOpen=db.open.bind(db);db.open=()=>Dexie.Promise.reject(new Error('Unavailable'));
  try {await db.initialize(demoInstallation(),legacy(realData()).store);assert.equal(db.mode,'legacy-readonly');assert.deepEqual(await db.readSnapshot(),migrated(realData()));await assert.rejects(db.write('events',[]));}
  finally {db.open=originalOpen;}
}));

test('corrupt legacy never triggers seed insertion and remains recoverable byte-for-byte',async()=>withDB(async db=>{
  const old=legacy(realData());old.values.set(LEGACY_KEYS.events,'{broken');const original=exportLegacyData(old.store);
  await assert.rejects(db.initialize(demoInstallation(),old.store));
  for(const table of db.tables)assert.equal(await table.count(),0);
  assert.equal(exportLegacyData(old.store),original);assert.equal(db.mode,'uninitialized');
}));

test('missing collections in an existing installation stay empty and never gain demo students or events',async()=>withDB(async db=>{
  const old=legacy();old.values.set(LEGACY_KEYS.profile,JSON.stringify(realData().profile));
  await db.initialize(demoInstallation(),old.store);
  for(const name of ['events','students','circulars','definitiveTimetable','provisionalTimetable'] as const)assert.deepEqual(await db.read(name),[]);
  assert.equal(await db.read('onboardingCompleted'),false);
}));

test('unknown legacy keys or missing profile suspend initialization instead of inserting demos',async()=>{
  for(const key of ['agedoc_unknown_v1',LEGACY_KEYS.events])await withDB(async db=>{
    const old=legacy();old.values.set(key,'[]');await assert.rejects(db.initialize(demoInstallation(),old.store));
    assert.equal(await db.table('events').count(),0);assert.equal(old.values.get(key),'[]');
  });
});

test('read failures never substitute demo records for real data',async()=>withDB(async db=>{
  await db.initialize(demoInstallation(),legacy(realData()).store);
  const fail=()=>{throw new Error('Read failed');};db.table('events').hook('reading',fail);
  await assert.rejects(db.read('events'),/Read failed/);
  db.table('events').hook('reading').unsubscribe(fail);
  assert.deepEqual(await db.read('events'),migrated(realData()).events);
}));

test('interrupted legacy restore journal is recovered before the migration snapshot',async()=>withDB(async db=>{
  const old=legacy(realData());old.values.set('agedoc_restore_journal_v1',JSON.stringify({[LEGACY_KEYS.profile]:old.values.get(LEGACY_KEYS.profile)}));
  old.values.set(LEGACY_KEYS.profile,JSON.stringify({...realData().profile,fullName:'Partial restore'}));
  await db.initialize(demoInstallation(),old.store);assert.equal((await db.read('profile')).fullName,realData().profile.fullName);
  assert.equal(old.values.has('agedoc_restore_journal_v1'),false);
}));

test('concurrent migrations commit one complete snapshot',async()=>withDB(async db=>{
  const other=new AgendaDatabase(db.name), old=legacy(realData());
  try {await Promise.all([db.initialize(demoInstallation(),old.store),other.initialize(demoInstallation(),old.store)]);assert.deepEqual(await other.readSnapshot(),migrated(realData()));}
  finally{other.close();}
}));

test('restore failure after writes to earlier collections leaves the entire previous DB intact',async()=>withDB(async db=>{
  await db.initialize(demoInstallation(),legacy(realData()).store);const before=await db.readSnapshot();
  const fail=()=>{throw new Error('Disk full');};db.table('students').hook('creating',fail);
  try {await assert.rejects(db.restore(demoInstallation()));}finally{db.table('students').hook('creating').unsubscribe(fail);}
  assert.deepEqual(await db.readSnapshot(),before);assert.equal((await db.table('metadata').get('migration')).value,1);
}));

test('invalid backup never modifies DB and full export/import roundtrip preserves the exact snapshot',async()=>withDB(async db=>{
  await db.initialize(demoInstallation(),legacy(realData()).store);const before=await db.readSnapshot();
  await assert.rejects(db.restore({...before,students:[{...before.students[0],notes:[null as any]}]}));assert.deepEqual(await db.readSnapshot(),before);
  const json=JSON.stringify(before);await db.restore(demoInstallation());await db.restore(JSON.parse(json));assert.deepEqual(await db.readSnapshot(),{...JSON.parse(json),timeSlotConfig:undefined});
}));

test('legacy validator rejects invalid modes, onboarding and duplicate IDs without normalizing user data',()=>{
  for(const [key,value] of [[LEGACY_KEYS.timetableMode,'wrong'],[LEGACY_KEYS.onboardingCompleted,'yes'],[LEGACY_KEYS.events,JSON.stringify([realData().events[0],realData().events[0]])]]){
    const old=legacy(realData());old.values.set(key,value);assert.throws(()=>readLegacyData(old.store));assert.equal(old.values.get(key),value);
  }
});

test('migrated DB opens even when legacy storage access is denied',async()=>withDB(async db=>{
  await db.initialize(demoInstallation(),legacy(realData()).store);db.close();
  const denied = legacy().store;denied.getItem=()=>{throw new Error('Denied');};
  await db.initialize(demoInstallation(),denied);assert.equal(db.mode,'indexeddb');assert.deepEqual(await db.readSnapshot(),migrated(realData()));
}));

test('failed legacy read on an empty DB never treats real data as a new installation',async()=>withDB(async db=>{
  const denied=legacy(realData()).store;denied.getItem=()=>{throw new Error('Read failed');};
  await assert.rejects(db.initialize(demoInstallation(),denied));assert.equal(await db.table('events').count(),0);
}));

test('legacy event links are inferred only for one exact circular match',async()=>withDB(async db=>{
  const data=realData();const item=data.circulars[0].extractedItems![0];
  data.events=[{...data.events[0],title:item.title,className:item.className,date:item.date,startTime:item.startTime,endTime:item.endTime,sourceCircularTitle:data.circulars[0].title,sourceCircularId:undefined,sourceItemId:undefined}];
  await db.initialize(demoInstallation(),legacy(data).store);
  const [event]=await db.read('events');assert.equal(event.sourceCircularId,data.circulars[0].id);assert.equal(event.sourceItemId,item.tempId);assert.equal(event.id,data.events[0].id);
}));

test('invalid edits cannot commit a database that would fail validation at the next startup',async()=>withDB(async db=>{
  await db.initialize(demoInstallation(),legacy(realData()).store);const before=await db.readSnapshot();
  await assert.rejects(db.write('definitiveTimetable',[{...before.definitiveTimetable[0],endTime:'00:00'}]));
  assert.deepEqual(await db.readSnapshot(),before);
  db.close();await db.initialize(demoInstallation(),legacy().store);assert.equal(db.mode,'indexeddb');assert.deepEqual(await db.readSnapshot(),before);
}));
