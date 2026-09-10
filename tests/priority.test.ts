import 'fake-indexeddb/auto';
import { database } from '../src/services/db';
import { initializeStorage } from '../src/services/storage';
import { getEventModalTimeFields } from "../src/components/EventModal";
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { localDateISO, nextDateISO, isValidDate, eventDateError } from '../src/utils/dates';
import { parseCircularText, normalizeExtractedItems, extractedItemError } from '../src/utils/circularParser';
import { evaluateItemRelevance, detectSubjects } from '../src/utils/circularRelevance';
import { analyzeCircular } from '../src/services/aiService';
import { normalizeSchoolLinkedData } from '../src/utils/multiSchool';
import { storage, convertExtractedItemToEvent, isCommitmentInEvents } from '../src/services/storage';
import { recoverBackupRestore } from '../src/services/backup';
import { linkLegacyCircularEvents } from '../src/utils/circularLinks';
import { createGoogleCalendarEvent, updateGoogleCalendarEvent, toGoogleCalendarPayload, getGoogleCalendarWebUrl, downloadIcsCalendar } from '../src/services/googleCalendarService';
import type { TeacherProfile, ExtractedItem, CalendarEvent, TimetableSlot, CircularDocument } from '../src/types';

const profile: TeacherProfile = { id:'teacher', fullName:'Docente test', schoolName:'Scuola test', schoolYear:'2027/2028', schoolLevel:'ssig', primarySubjects:['Scienze motorie'], classes:['1A','2E','3B'], campuses:['Centrale'], roles:[] };
const item: ExtractedItem = { tempId:'item-1', title:'Consiglio 1A', category:'consiglio_classe', date:'2027-09-14', startTime:'15:00', endTime:'16:00', className:'1A', relevance:'VERDE', relevanceReason:'Classe assegnata', selectedForImport:true };
const doc: CircularDocument = { id:'circ-1', title:'Circolare test', fileName:'test.txt', fileType:'text', uploadDate:'2027-09-01', extractedCount:1, relevantCount:1, extractedItems:[item] };
const slot: TimetableSlot = { id:'def', dayOfWeek:1, periodNumber:1, startTime:'08:00',endTime:'09:00',subject:'Scienze motorie',className:'1A' };
const event: CalendarEvent = { id:'manual', title:'Riunione privata', category:'personale', date:item.date, startTime:item.startTime, endTime:item.endTime, isAllDay:false, sourceType:'manuale' };
let memory: Map<string,string>;
let failKey: string | undefined;
beforeEach(async () => {
  memory = new Map(); failKey = undefined;
  Object.defineProperty(globalThis, 'localStorage', { configurable:true, value:{
    get length(){return memory.size;}, key:(i:number)=>[...memory.keys()][i] ?? null,
    getItem:(k:string)=>memory.get(k) ?? null,
    setItem:(k:string,v:string)=>{ if(k===failKey){failKey=undefined;throw new Error('QuotaExceededError');} memory.set(k,String(v)); },
    removeItem:(k:string)=>memory.delete(k),
  }});
  database.close(); await database.delete(); await initializeStorage();
  (await storage.saveProfile(profile));(await storage.saveEvents([]));(await storage.saveStudents([]));
  (await storage.saveDefinitiveTimetable([slot]));(await storage.saveProvisionalTimetable([{...slot,id:'prov',startTime:'09:00',endTime:'10:00'}]));
  (await storage.setTimetableMode('provvisorio'));(await storage.setOnboardingCompleted(true));
});

test('civil days stay correct at Rome midnight, summer and winter',()=>{
  assert.equal(localDateISO(new Date(2026,8,14)), '2026-09-14');
  assert.equal(localDateISO(new Date(2026,0,14)), '2026-01-14');
  assert.equal(localDateISO(new Date(2026,8,14,0,1)), '2026-09-14');
});
test('next day handles year, leap day and DST transitions',()=>{
  assert.equal(nextDateISO('2026-12-31'),'2027-01-01');
  assert.equal(nextDateISO('2028-02-28'),'2028-02-29');
  assert.equal(nextDateISO('2026-03-29'),'2026-03-30');
  assert.equal(isValidDate('2027-02-29'),false);
});
test('manual event intervals reject missing, equal and reversed times',()=>{
  assert.ok(eventDateError({...event,endTime:'14:00'}));
  assert.ok(eventDateError({...event,endTime:'15:00'}));
  assert.ok(eventDateError({...event,endTime:undefined}));
  assert.equal(eventDateError({...event,isAllDay:true}),null);
});
for(const date of ['14/09/2027','14.09.2027','14-09-2027','14 settembre 2027']) test(`parser accepts ${date}`,()=>{
  const [x]=parseCircularText(`${date} Collegio docenti 15:00-17:00`,profile);
  assert.equal(x.date,'2027-09-14');assert.equal(x.startTime,'15:00');assert.equal(x.endTime,'17:00');
  assert.equal(x.title,'Collegio docenti');assert.equal(x.selectedForImport,true);
});
test('no document-specific injected events or locations',()=>{
  assert.deepEqual(parseCircularText('Documento aggiornato il 08/09/2027',profile),[]);
  const [x]=parseCircularText('14/10/2027 Aggiornamento classi intermedie 14:00-15:00',profile);
  assert.equal(x.startTime,'14:00');assert.equal(x.endTime,'15:00');assert.equal(x.location,'');
});
test('yearless dates follow school year on both sides of January',()=>{
  const x=parseCircularText('14/09 Collegio docenti 15:00-17:00\n14/01 Collegio docenti 15:00-17:00',profile);
  assert.deepEqual(x.map(i=>i.date),['2027-09-14','2028-01-14']);
});
test('dotted clocks are not dates; header date applies to following rows',()=>{
  const x=parseCircularText('14/09/2027\nCollegio docenti 09.00-10.00\nConsiglio 1A 10.00-11.00',profile);
  assert.equal(x.length,2);assert.ok(x.every(i=>i.date==='2027-09-14'));
  assert.equal(x[1].startTime,'10:00');
});
test('missing or invalid dates and hours remain uncertain and unselected',()=>{
  for(const text of ['Collegio docenti','31/02/2027 Collegio docenti 15:00-17:00','14/09/2027 Collegio docenti']){
    const [x]=parseCircularText(text,profile);assert.equal(x.selectedForImport,false);assert.ok(extractedItemError(x));
  }
});
test('cancelled meeting is not added as an event',()=>assert.deepEqual(parseCircularText('14/09/2027 Consiglio 1A annullato 15:00-16:00',profile),[]));
test('cloud normalization never supplies default times or school locations',()=>{
  const [x]=normalizeExtractedItems([{title:'Collegio docenti',date:'2027-09-14',category:'collegio_docenti'}],profile);
  assert.equal(x.startTime,undefined);assert.equal(x.endTime,undefined);assert.equal(x.location,'');assert.equal(x.selectedForImport,false);
});
test('class plus subject matches the original specification',()=>{
  const inputs=['1A - Italiano','1A - Matematica','1A - Scienze motorie','1B - Italiano','2E - Scienze motorie','3C - Inglese','3B - Scienze motorie'];
  assert.deepEqual(inputs.map(title=>evaluateItemRelevance({title},profile).relevance),['ROSSO','ROSSO','VERDE','ROSSO','VERDE','ROSSO','VERDE']);
});
test('foreign departments cannot become green through school level',()=>{
  assert.equal(evaluateItemRelevance({title:'Dipartimento Matematica SSIG'},profile).relevance,'ROSSO');
  assert.equal(evaluateItemRelevance({title:'Dipartimenti SSIG'},profile).relevance,'GIALLO');
});
test('subject aliases and explicit unknown subjects are respected',()=>{
  assert.deepEqual(detectSubjects('Educazione fisica'),['scienze motorie']);
  assert.deepEqual(detectSubjects('Scienze motorie'),['scienze motorie']);
  assert.equal(evaluateItemRelevance({title:'1A',subject:'Diritto'},profile).relevance,'ROSSO');
});
test('school level and reserved roles restrict even matching classes',()=>{
  assert.equal(evaluateItemRelevance({title:'Primaria Consiglio 1A'},profile).relevance,'ROSSO');
  assert.equal(evaluateItemRelevance({title:'Staff riunione 1A'},profile).relevance,'ROSSO');
  assert.equal(evaluateItemRelevance({title:'Tutti i docenti: collegio'},profile).relevance,'VERDE');
  assert.equal(evaluateItemRelevance({title:'1A attività facoltativa'},profile).relevance,'GIALLO');
});
test('PDF offline is a failed analysis, not successful empty extraction',async()=>{
  const previous=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('offline')};
  try { const result=await analyzeCircular({imageBase64:'test',mimeType:'application/pdf',profile});assert.equal(result.success,false);assert.match(result.error!,/online/); }
  finally{globalThis.fetch=previous;}
});
test('text remains usable offline',async()=>{
  const previous=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('offline')};
  try{const result=await analyzeCircular({text:'14/09/2027 Collegio docenti 15:00-17:00',profile});assert.equal(result.success,true);assert.equal(result.items.length,1);}
  finally{globalThis.fetch=previous;}
});
test('circular cancellation leaves unrelated manual events intact',async ()=>{
  (await storage.saveEvents([event]));assert.equal((await storage.deleteEventMatchingExtractedItem(item,doc.id)),false);assert.equal((await storage.getEvents())[0].id,'manual');
});
test('stable links survive edits and target only the correct circular',async ()=>{
  const linked=convertExtractedItemToEvent(item,doc.title,doc.id);
  const other=convertExtractedItemToEvent(item,'Other','circ-other');
  (await storage.saveEvents([event,{...linked,title:'Modified title'},other]));
  assert.equal(isCommitmentInEvents(item,(await storage.getEvents()),doc.id),true);
  assert.equal((await storage.deleteEventMatchingExtractedItem(item,doc.id)),true);
  assert.deepEqual((await storage.getEvents()).map(e=>e.id),[event.id,other.id]);
});
test('reimporting one circular item is idempotent without losing unrelated events',async ()=>{
  (await storage.saveEvents([event]));const linked=convertExtractedItemToEvent(item,doc.title,doc.id);
  assert.equal((await storage.bulkAddEvents([linked])),1);assert.equal((await storage.bulkAddEvents([linked])),0);assert.equal((await storage.getEvents()).length,2);
});
test('incomplete extracted events cannot be converted using invented times',()=>{
  assert.throws(()=>convertExtractedItemToEvent({...item,startTime:undefined},doc.title,doc.id));
});
test('legacy links require exact unique document and item, never a manual event',()=>{
  const old={...event,title:item.title,sourceType:'circolare' as const,sourceCircularTitle:doc.title,className:'1A'};
  assert.equal(linkLegacyCircularEvents([old],[doc])[0].sourceCircularId,doc.id);
  assert.equal(linkLegacyCircularEvents([old],[doc,{...doc,id:'ambiguous'}])[0].sourceCircularId,undefined);
  assert.equal(linkLegacyCircularEvents([event],[doc])[0].sourceCircularId,undefined);
});
test('v3 backup round-trips both timetables, mode and onboarding',async ()=>{
  const backup=(await storage.exportDataBackup());(await storage.saveDefinitiveTimetable([]));(await storage.saveProvisionalTimetable([]));(await storage.setTimetableMode('auto'));(await storage.setOnboardingCompleted(false));
  assert.equal((await storage.importDataBackup(backup)),true);
  assert.equal((await storage.getDefinitiveTimetable())[0].id,'def');assert.equal((await storage.getProvisionalTimetable())[0].id,'prov');
  assert.equal((await storage.getTimetableMode()),'provvisorio');assert.equal((await storage.hasCompletedOnboarding()),true);
});
test('v2 backups remain readable without erasing the existing second timetable',async ()=>{
  const v3=JSON.parse((await storage.exportDataBackup()));const {definitiveTimetable,provisionalTimetable,timetableMode,onboardingCompleted,...base}=v3;
  assert.equal((await storage.importDataBackup(JSON.stringify({...base,version:2,timetable:[{...slot,id:'legacy'}]}))),true);
  assert.equal((await storage.getDefinitiveTimetable())[0].id,'legacy');assert.equal((await storage.getProvisionalTimetable())[0].id,'prov');
});
test('malformed and nested invalid backups do not touch any data',async ()=>{
  for(const mutate of [(b:any)=>({}), (b:any)=>({...b,version:99}), (b:any)=>({...b,students:[{id:'x',fullName:'X',className:'1A',notes:[null]}]}), (b:any)=>({...b,profile:{...b.profile,roles:'bad'}})]){
    const valid=JSON.parse((await storage.exportDataBackup()));const before=await database.readSnapshot();
    assert.equal((await storage.importDataBackup(JSON.stringify(mutate(valid)))),false);assert.deepEqual(await database.readSnapshot(),before);
  }
});
test('write failure during restore rolls back previous contents',async ()=>{
  const b=JSON.parse((await storage.exportDataBackup()));const before=await database.readSnapshot();b.profile.fullName='Changed';b.events=[event];
  const fail = () => { throw new Error('QuotaExceededError'); };
  database.table('events').hook('creating', fail);
  try { assert.equal((await storage.importDataBackup(JSON.stringify(b))),false); }
  finally { database.table('events').hook('creating').unsubscribe(fail); }
  assert.deepEqual(await database.readSnapshot(),before);
});
test('interrupted restore journal is recovered on startup',async ()=>{
  const original=JSON.stringify(profile);
  memory.set('agedoc_restore_journal_v1',JSON.stringify({'agedoc_teacher_profile_v2':original}));
  memory.set('agedoc_teacher_profile_v2',JSON.stringify({...profile,fullName:'Interrupted change'}));
  recoverBackupRestore();assert.equal((await storage.getProfile()).fullName,profile.fullName);assert.equal(memory.has('agedoc_restore_journal_v1'),false);
});
test('reading circulars never substitutes demo text for the original',async ()=>{
  (await storage.saveCircular({...doc,title:'Impegni di settembre',rawText:'08/09/2027',extractedItems:[]}));
  assert.deepEqual((await storage.getCirculars())[0].extractedItems,[]);
});
test('all-day exports use exclusive next-day end in API and link',()=>{
  const allDay={...event,date:'2026-12-31',isAllDay:true};
  assert.equal(toGoogleCalendarPayload(allDay).end.date,'2027-01-01');
  assert.match(getGoogleCalendarWebUrl(allDay),/20261231\/20270101/);
});

test('ICS preserves exclusive end across year boundary',async()=>{
  let captured: Blob | undefined;
  const oldCreate=URL.createObjectURL;const oldRevoke=URL.revokeObjectURL;
  const oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
  URL.createObjectURL=(blob:Blob)=>{captured=blob;return 'blob:test';};URL.revokeObjectURL=()=>{};
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>({click(){}}),body:{appendChild(){},removeChild(){}}}});
  try { downloadIcsCalendar([{...event,date:'2026-12-31',isAllDay:true}]); assert.match(await captured!.text(),/DTEND;VALUE=DATE:20270101/); }
  finally {URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else delete (globalThis as any).document;}
});
test('compound teacher subjects and explicit chosen location are supported',()=>{
  assert.equal(evaluateItemRelevance({title:'Dipartimento Matematica'},{...profile,primarySubjects:['Matematica e Scienze']}).relevance,'VERDE');
  assert.equal(normalizeExtractedItems([item],profile,'Sede scelta')[0].location,'Sede scelta');
});
test('a legacy demo-seeded installation can be backed up and restored by the new validator',async ()=>{
  memory.clear();database.close();await database.delete();await initializeStorage();const backup=(await storage.exportDataBackup());assert.equal((await storage.importDataBackup(backup)),true);
});
test('corrupt circular archive does not replace valid manual events',async ()=>{
  (await storage.saveEvents([event]));memory.set('agedoc_circulars_v2','not json');assert.deepEqual((await storage.getEvents()),[event]);
});

const invalidIntervals: Array<[string, Partial<CalendarEvent>]> = [
  ['both times absent', { startTime: undefined, endTime: undefined }],
  ['start absent', { startTime: undefined }],
  ['end absent', { endTime: undefined }],
  ['empty start', { startTime: '' }],
  ['empty end', { endTime: '' }],
  ['invalid start', { startTime: '24:00' }],
  ['invalid end', { endTime: '16:99' }],
  ['equal times', { endTime: '15:00' }],
  ['reversed times', { endTime: '14:59' }],
];

for (const [label, times] of invalidIntervals) {
  test(`API payload, web link and ICS reject ${label}`, async () => {
    const invalid = { ...event, ...times };
    const error = /Impossibile esportare/;
    assert.throws(() => toGoogleCalendarPayload(invalid), error);
    assert.throws(() => getGoogleCalendarWebUrl(invalid), error);
    // A valid preceding event must not cause a partial download.
    assert.throws(() => downloadIcsCalendar([event, invalid]), error);
    let apiCalls = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = async () => { apiCalls++; throw new Error('Unexpected network request'); };
    try {
      await assert.rejects(createGoogleCalendarEvent('test-token', invalid), error);
      await assert.rejects(updateGoogleCalendarEvent('test-token', 'remote-id', invalid), error);
      assert.equal(apiCalls, 0);
    } finally { globalThis.fetch = previous; }
  });
}

async function backupForVersion(version: 2 | 3) {
  const data = JSON.parse((await storage.exportDataBackup()));
  if (version === 3) return data;
  const { definitiveTimetable, provisionalTimetable, timetableMode, onboardingCompleted, ...common } = data;
  return { ...common, version: 2, timetable: definitiveTimetable };
}

for (const version of [2, 3] as const) {
  test(`v${version} backups reject missing, malformed or non-increasing event times without writes`, async () => {
    for (const [, times] of invalidIntervals) {
      const data = (await backupForVersion(version));
      data.events = [{ ...event, ...times }];
      const before = await database.readSnapshot();
      assert.equal((await storage.importDataBackup(JSON.stringify(data))), false);
      assert.deepEqual(await database.readSnapshot(), before);
    }
  });
  test(`v${version} backups accept an all-day event without any times`, async () => {
    const data = (await backupForVersion(version));
    data.events = [{ ...event, isAllDay: true, startTime: undefined, endTime: undefined }];
    assert.equal((await storage.importDataBackup(JSON.stringify(data))), true);
    assert.equal((await storage.getEvents())[0].isAllDay, true);
    assert.equal((await storage.getEvents())[0].startTime, undefined);
    assert.equal((await storage.getEvents())[0].endTime, undefined);
  });
  test(`v${version} timetables reject equal and reversed intervals without writes`, async () => {
    const keys = version === 2 ? ['timetable'] : ['definitiveTimetable', 'provisionalTimetable'];
    for (const key of keys) for (const endTime of ['08:00', '07:59']) {
      const data = (await backupForVersion(version));
      data[key] = [{ ...slot, endTime }];
      const before = await database.readSnapshot();
      assert.equal((await storage.importDataBackup(JSON.stringify(data))), false);
      assert.deepEqual(await database.readSnapshot(), before);
    }
  });
}

test('all-day exports do not require times and keep exclusive end date', async () => {
  const allDay = { ...event, date: '2026-12-31', isAllDay: true, startTime: undefined, endTime: undefined };
  assert.deepEqual(toGoogleCalendarPayload(allDay).start, { date: '2026-12-31' });
  assert.deepEqual(toGoogleCalendarPayload(allDay).end, { date: '2027-01-01' });
  assert.match(getGoogleCalendarWebUrl(allDay), /dates=20261231\/20270101/);
  let captured: Blob | undefined;
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  URL.createObjectURL = (blob: Blob) => { captured = blob; return 'blob:test'; };
  URL.revokeObjectURL = () => {};
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ click() {} }), body: { appendChild() {}, removeChild() {} },
  } });
  try {
    downloadIcsCalendar([allDay, event]);
    const content = await captured!.text();
    assert.match(content, /DTSTART;VALUE=DATE:20261231/);
    assert.match(content, /DTEND;VALUE=DATE:20270101/);
    assert.match(content, /DTSTART:20270914T150000/);
    assert.match(content, /DTEND:20270914T160000/);
  } finally {
    URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
    else delete (globalThis as any).document;
  }
});

test('valid timed exports preserve the exact interval without a default duration', () => {
  const shortEvent = { ...event, startTime: '22:50', endTime: '23:05' };
  const payload = toGoogleCalendarPayload(shortEvent);
  assert.equal(payload.start.dateTime, `${event.date}T22:50:00`);
  assert.equal(payload.end.dateTime, `${event.date}T23:05:00`);
  assert.match(getGoogleCalendarWebUrl(shortEvent), /20270914T225000\/20270914T230500/);
});

test('editing an incomplete event keeps missing times and location blank', () => {
  for (const source of [
    { ...event, startTime: undefined, endTime: undefined, location: undefined },
    { ...event, sourceType: 'circolare' as const, startTime: undefined, endTime: undefined, location: undefined },
  ]) {
    const fields = getEventModalTimeFields(source);
    assert.deepEqual(fields, { startTime: '', endTime: '', location: '' });
    assert.ok(eventDateError({ ...source, ...fields }));
  }
});

test('prefilled circular data never gains absent start, end or location', () => {
  for (const source of [
    { sourceType: 'circolare' as const, date: event.date, startTime: '14:10' },
    { sourceType: 'circolare' as const, date: event.date, endTime: '17:20' },
    {},
  ]) {
    const fields = getEventModalTimeFields(source);
    assert.equal(fields.startTime, source.startTime ?? '');
    assert.equal(fields.endTime, source.endTime ?? '');
    assert.equal(fields.location, '');
    assert.ok(eventDateError({ date: event.date, ...fields, isAllDay: false }));
  }
});

test('manual defaults remain available but cannot overwrite provided values', () => {
  assert.deepEqual(getEventModalTimeFields(), { startTime: '15:00', endTime: '16:30', location: 'Sede Centrale' });
  const existing = { startTime: '10:15', endTime: '10:45', location: 'Aula 4' };
  assert.deepEqual(getEventModalTimeFields(existing), existing);
  assert.deepEqual(getEventModalTimeFields({ isAllDay: true }), { startTime: '', endTime: '', location: '' });
});

test('syncCircularCommitments defaults to VERDE/GIALLO and skips ROSSO', async () => {
  const items: ExtractedItem[] = ['VERDE', 'GIALLO', 'ROSSO'].map((relevance, i) => ({
    ...item, tempId: `color-${i}`, title: `Impegno ${i}`, relevance: relevance as ExtractedItem['relevance'],
    // Selection flags must not bypass the relevance filter.
    selectedForImport: relevance === 'ROSSO',
  }));
  (await storage.saveCircular({ ...doc, extractedItems: items }));
  assert.equal((await storage.syncCircularCommitments(doc.id)), 2);
  assert.deepEqual((await storage.getEvents()).map(e => e.sourceItemId), ['color-0', 'color-1']);
  assert.equal((await storage.syncCircularCommitments(doc.id)), 0);
  assert.equal((await storage.syncCircularCommitments(doc.id, false)), 1);
  assert.equal((await storage.getEvents()).at(-1)!.sourceItemId, 'color-2');
});

test('concurrent event and note writes retain both changes',async()=>{
  await Promise.all([storage.saveEvent({...event,id:'first'}),storage.saveEvent({...event,id:'second'})]);
  assert.deepEqual((await storage.getEvents()).map(e=>e.id),['first','second']);
  const student={id:'test-student',fullName:'Studente',className:'1A',notes:[]};await storage.saveStudent(student);
  const note={id:'n1',date:'2027-09-01',category:'didattica' as const,title:'Nota',content:'Testo',createdAt:'2027-09-01T09:00:00Z'};
  await Promise.all([storage.addStudentNote(student.id,note),storage.addStudentNote(student.id,{...note,id:'n2'})]);
  assert.deepEqual(new Set((await storage.getStudents())[0].notes.map(n=>n.id)),new Set(['n1','n2']));
});

test('all local operations and backup roundtrip work with network unavailable',async()=>{
  const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Offline');};
  try {
    await storage.saveProfile({...profile,fullName:'Offline'});await storage.saveEvent(event);await storage.saveCircular(doc);
    await storage.saveTimetableSlot({...slot,id:'offline'},'provvisorio');
    await storage.saveStudent({id:'offline',fullName:'Studente',className:'1A',notes:[]});
    await storage.addStudentNote('offline',{id:'note',date:'2027-09-01',category:'didattica',title:'Nota',content:'Offline',createdAt:'2027-09-01T09:00:00Z'});
    const before=await database.readSnapshot(), backup=await storage.exportDataBackup();await storage.deleteEvent(event.id);
    assert.equal(await storage.importDataBackup(backup),true);assert.deepEqual(await database.readSnapshot(),normalizeSchoolLinkedData(before));assert.equal(calls,0);
  }finally{globalThis.fetch=original;}
});
