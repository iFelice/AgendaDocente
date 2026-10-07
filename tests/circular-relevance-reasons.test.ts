import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateItemRelevance, isRelevanceReasonText } from '../src/utils/circularRelevance';
import type { TeacherProfile } from '../src/types';

const curricularProfile: TeacherProfile = {
  id: 'curricular', fullName: 'Docente test', schoolName: 'Scuola test', schoolLevel: 'ssig',
  schoolYear: '2026/2027', primarySubjects: ['Matematica'], classes: ['3E'], campuses: [], roles: [],
  isSupportTeacher: false,
};

const supportProfile: TeacherProfile = {
  ...curricularProfile,
  id: 'support',
  primarySubjects: ['Sostegno'],
  classes: ['3E', '1C'],
  isSupportTeacher: true,
};

const otherSubjectProfile: TeacherProfile = {
  ...curricularProfile,
  primarySubjects: ['Storia'],
};

test('ogni ramo di evaluateItemRelevance genera un motivo riconosciuto', () => {
  const cases: { name: string; item: Parameters<typeof evaluateItemRelevance>[0]; profile?: TeacherProfile }[] = [
    { name: 'altro ordine scolastico', item: { title: 'Riunione', notes: 'Per la scuola primaria' } },
    { name: 'staff', item: { title: 'Riunione', notes: 'Incontro riservato allo staff' } },
    { name: 'coordinatori', item: { title: 'Riunione', notes: 'Riservata ai coordinatori' } },
    { name: 'classi non assegnate', item: { title: 'Riunione', recipientClasses: ['2B', '4C'] } },
    { name: 'anno non assegnato', item: { title: 'Riunione', recipientGrades: [2] } },
    {
      name: 'anno di sostegno singolare', profile: supportProfile,
      item: { title: 'Progetto matematico', subject: 'Matematica', notes: 'Rivolto alle classi III' },
    },
    {
      name: 'anni di sostegno plurali', profile: supportProfile,
      item: { title: 'Progetto matematico', subject: 'Matematica', notes: 'Rivolto alle classi I e III' },
    },
    {
      name: 'classe pertinente per sostegno', profile: supportProfile,
      item: { title: 'Verifica di matematica', subject: 'Matematica', recipientClasses: ['3E'] },
    },
    { name: 'altra materia con sigle', profile: otherSubjectProfile, item: { title: 'Colloqui', subject: 'MAT-SM' } },
    { name: 'partecipazione facoltativa', item: { title: 'Riunione facoltativa' } },
    { name: 'classe e materia pertinenti', item: { title: 'Verifica di matematica classe 3E', subject: 'Matematica' } },
    { name: 'classe pertinente', item: { title: 'Riunione per la classe 3E' } },
    { name: 'materia riconosciuta da sigla', profile: supportProfile, item: { title: 'Riunione', rawSnippet: 'DOCENTI SOS' } },
    { name: 'materia del docente', item: { title: 'Riunione di Matematica' } },
    { name: 'tutti i docenti', item: { title: 'Collegio docenti', category: 'collegio_docenti' } },
    { name: 'dipartimento da verificare', item: { title: 'Dipartimento' } },
    { name: 'ordine scolastico pertinente', item: { title: 'Riunione', rawSnippet: 'SSIG' } },
    { name: 'destinatari non specificati', item: { title: 'Riunione' } },
  ];

  const generated = cases.map(({ name, item, profile }) => {
    const reason = evaluateItemRelevance(item, profile || curricularProfile).relevanceReason;
    assert.equal(isRelevanceReasonText(reason), true, `${name}: ${reason}`);
    return reason;
  });

  assert.equal(generated.length, 18);
  assert.equal(new Set(generated).size, 18, cases.map(({ name }, index) => `${name}: ${generated[index]}`).join('\n'));
});

test('il riconoscimento richiede la frase completa e rifiuta testo libero', () => {
  assert.equal(isRelevanceReasonText('Pertinente per 3D. Portare il registro'), false);
  assert.equal(isRelevanceReasonText('Portare il registro alla riunione.'), false);
  assert.equal(isRelevanceReasonText('Destinato a tutti i docenti. Portare il registro.'), false);
});
