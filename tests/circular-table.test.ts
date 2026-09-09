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
test('ready examples removed while real upload/text and archive entry remain',async()=>{
 const modal=await readFile('src/components/CircularAnalyzerModal.tsx','utf8');
 assert.doesNotMatch(modal,/SAMPLE_CIRCULARS|samples|Esempi Pronti/);
 assert.match(modal,/Carica File/);assert.match(modal,/Incolla Testo Circolare/);
 assert.doesNotMatch(await readFile('src/services/aiService.ts','utf8'),/SAMPLE_CIRCULARS/);
 assert.doesNotMatch(await readFile('src/components/CircularsArchiveView.tsx','utf8'),/circolare di esempio/);
});
