import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseCircularText, normalizeExtractedItems, extractedItemError } from '../src/utils/circularParser';
import { evaluateItemRelevance } from '../src/utils/circularRelevance';
import { convertExtractedItemToEvent } from '../src/services/storage';
import type { TeacherProfile } from '../src/types';
const profile: TeacherProfile = {id:'test',fullName:'Test',schoolName:'Test',schoolYear:'2026/2027',schoolLevel:'ssig',primarySubjects:['Italiano'],classes:['1A'],campuses:[],roles:[]};
const title='PREDISPOSIZIONE AMBIENTI DIDATTICI, PROGRAMMAZIONE GENERALE PER MATERIA';
// Minimal synthetic rows, no school document or personal data.
const rows=['PRIMARIA | PROGRAMMAZIONE ANNUALE | 09:00-11:00','PRIMARIA | INTERCLASSE | 11:00-13:00',`SSIG | ${title} | 09:00-12:00`];
for(const layout of ['rows','blocks']) test(`adjacent Primaria/SSIG ${layout} keep row-local times and shared date`,()=>{
 const text='07/09/2026\n'+rows.map(r=>layout==='blocks'?r.replaceAll(' | ','\n'):r).join('\n');
 const items=parseCircularText(text,profile);
 assert.equal(items.length,3);
 assert.deepEqual(items.map(i=>[i.date,i.startTime,i.endTime]),[['2026-09-07','09:00','11:00'],['2026-09-07','11:00','13:00'],['2026-09-07','09:00','12:00']]);
 assert.deepEqual(items.map(i=>i.relevance),['ROSSO','ROSSO','GIALLO']);
 const event=convertExtractedItemToEvent({...items[2],selectedForImport:true}, 'Circolare sintetica', 'synthetic-table');
 assert.equal(event.startTime,'09:00');assert.equal(event.endTime,'12:00');
});
test('missing SSIG interval never inherits previous or following Primaria hours',()=>{
 for(const text of [`07/09/2026\n${rows[0]}\nSSIG\n${title}`,`07/09/2026\nSSIG\n${title}\n${rows[1]}`]){
  const item=parseCircularText(text,profile).find(i=>i.title.includes('PREDISPOSIZIONE'))!;
  assert.equal(item.startTime,undefined);assert.equal(item.endTime,undefined);assert.equal(item.selectedForImport,false);
 }
});
test('cloud row evidence corrects mismatched times and ignores model red/generic subject',()=>{
 for(const subject of ['','Tutte le materie','Programmazione generale per materia']) {
  const [item]=normalizeExtractedItems([{title,date:'2026-09-07',startTime:'09:00',endTime:'11:00',subject,notes:'SSIG',rawSnippet:`SSIG | ${title} | 09:00-12:00`,relevance:'ROSSO'}],profile);
  assert.equal(item.startTime,'09:00');assert.equal(item.endTime,'12:00');assert.notEqual(item.relevance,'ROSSO');assert.equal(extractedItemError(item),null);
 }
});
test('ambiguous row excerpts and incomplete evidence cannot invent end times',()=>{
 for(const rawSnippet of [`SSIG ${title} 09:00`,rows.join('\n')]){
  const [item]=normalizeExtractedItems([{title,date:'2026-09-07',startTime:'09:00',endTime:'11:00',rawSnippet}],profile);
  assert.equal(item.endTime,undefined);assert.equal(item.selectedForImport,false);
 }
});
test('same school level does not override explicit class, subject or recipient exclusion',()=>{
 for(const fields of [{className:'2B'},{subject:'Matematica'},{notes:'Riservato ai soli coordinatori'}])
  assert.equal(evaluateItemRelevance({title:`SSIG ${title}`,...fields},profile).relevance,'ROSSO');
 assert.notEqual(evaluateItemRelevance({title:'PRIMARIA PROGRAMMAZIONE ANNUALE'}, {...profile,schoolLevel:'primaria'}).relevance,'ROSSO');
 assert.equal(evaluateItemRelevance({title:`SSIG ${title}`},{...profile,schoolLevel:'primaria'}).relevance,'ROSSO');
});
test('dotted civil date in excerpt is not a clock interval',()=>{
 const [item]=normalizeExtractedItems([{title:'SSIG Riunione',date:'2026-09-07',rawSnippet:'07.09.2026 SSIG Riunione 09:00-12:00'}],profile);
 assert.equal(item.startTime,'09:00');assert.equal(item.endTime,'12:00');
});
test('vertically merged ORARI cell serves every row of the shared-date block',()=>{
 // Synthetic layout of the real 04/09/2026 beta table (no school document, no personal data):
 // one date anchor, two recipients (PRIMARIA + SSIG) and a single ORARI cell "09.00-12.00" merged vertically.
 const merged=['04/09/2026','PRIMARIA','FORMAZIONE CLASSI / PREDISPOSIZIONE AMBIENTI DIDATTICI SISTO','SSIG','AGGIORNAMENTO CLASSI INTERMEDIE','(nuovi ingressi, nulla osta, acquisizione nuova documentazione)','composizione spontanea BONIFAZI','09.00-12.00'].join('\n');
 const items=parseCircularText(merged,profile);
 assert.equal(items.length,2);
 const ssig=items.find(i=>/SSIG/.test(i.title))!, primaria=items.find(i=>/PRIMARIA/.test(i.title))!;
 assert.equal(ssig.date,'2026-09-04');assert.equal(primaria.date,'2026-09-04');
 // The merged interval is visible in BOTH rows…
 assert.deepEqual([ssig.startTime,ssig.endTime],['09:00','12:00']);
 assert.deepEqual([primaria.startTime,primaria.endTime],['09:00','12:00']);
 // …and the never-reproducible wrong value stays absent.
 for(const item of items){
  assert.notEqual(item.startTime,'12:30');assert.notEqual(item.endTime,'12:30');
  assert.ok(!item.startTime||!item.endTime||item.endTime>item.startTime);
 }
 // Extract-first: SSIG keeps the shared time even though Primaria is filtered out by relevance.
 assert.equal(primaria.relevance,'ROSSO');assert.notEqual(ssig.relevance,'ROSSO');
});
test('a merged ORARI cell never leaks past a date anchor nor into rows with their own time',()=>{
 const leaked=['04/09/2026','SSIG','AGGIORNAMENTO CLASSI INTERMEDIE','09.00-12.00','07/09/2026','PRIMARIA','RICEVIMENTO GENITORI','12.30'].join('\n');
 const items=parseCircularText(leaked,profile);
 const ssig=items.find(i=>/AGGIORNAMENTO/.test(i.title))!;
 const nextDay=items.find(i=>/RICEVIMENTO/.test(i.title))!;
 assert.deepEqual([ssig.date,ssig.startTime,ssig.endTime],['2026-09-04','09:00','12:00']);
 // The following band must not receive the previous merged interval, nor a full-day collapse.
 assert.equal(nextDay.date,'2026-09-07');assert.equal(nextDay.endTime,undefined);
 if(nextDay.startTime!==undefined)assert.ok(!nextDay.endTime||nextDay.endTime>nextDay.startTime);
 // A row that already owns its inline interval is visually outside the merged cell.
 const mixed=['04/09/2026','PRIMARIA | INTERCLASSE | 11:00-13:00','SSIG','AGGIORNAMENTO CLASSI INTERMEDIE','09.00-12.00'].join('\n');
 const [ownInterval,mergedRow]=parseCircularText(mixed,profile);
 assert.deepEqual([ownInterval.startTime,ownInterval.endTime],['11:00','13:00']);
 assert.deepEqual([mergedRow.startTime,mergedRow.endTime],['09:00','12:00']);
});
test('equal or reversed model intervals are discarded, never shown nor auto-selected',()=>{
 for(const times of [{startTime:'12:30',endTime:'12:30'},{startTime:'12:00',endTime:'09:00'}]){
  // Without any row-local time evidence the fabricated interval cannot survive normalization.
  const [item]=normalizeExtractedItems([{title:'Riunione SSIG',category:'riunione',date:'2026-09-04',...times,notes:'SSIG'}],profile);
  assert.equal(item.startTime,undefined);assert.equal(item.endTime,undefined);assert.equal(item.selectedForImport,false);
  const [withSnippet]=normalizeExtractedItems([{title:'AGGIORNAMENTO CLASSI INTERMEDIE',category:'formazione',date:'2026-09-04',...times,rawSnippet:'SSIG AGGIORNAMENTO CLASSI INTERMEDIE | 09.00-12.00',notes:'SSIG'}],profile);
  assert.deepEqual([withSnippet.startTime,withSnippet.endTime],['09:00','12:00']);
 }
 // Snippet without any readable interval: the model time is unsupported evidence.
 const [noEvidence]=normalizeExtractedItems([{title:'AGGIORNAMENTO CLASSI INTERMEDIE',date:'2026-09-04',startTime:'12:30',endTime:'12:30',rawSnippet:'SSIG AGGIORNAMENTO CLASSI INTERMEDIE'}],profile);
 assert.equal(noEvidence.startTime,undefined);assert.equal(noEvidence.endTime,undefined);
});
test('ready examples removed while real upload/text and archive entry remain',async()=>{
 const modal=await readFile('src/components/CircularAnalyzerModal.tsx','utf8');
 assert.doesNotMatch(modal,/SAMPLE_CIRCULARS|samples|Esempi Pronti/);
 assert.match(modal,/Carica File/);assert.match(modal,/Incolla Testo Circolare/);
 assert.doesNotMatch(await readFile('src/services/aiService.ts','utf8'),/SAMPLE_CIRCULARS/);
 assert.doesNotMatch(await readFile('src/components/CircularsArchiveView.tsx','utf8'),/circolare di esempio/);
});
