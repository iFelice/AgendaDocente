import type { TeacherProfile } from "../types";

/**
 * Interpretazione canonica del tipo docente (curricolare / sostegno):
 * l'unica fonte di verità per tutta l'app, costruita su
 * `TeacherProfile.isSupportTeacher` (audit: niente teacherRole).
 *
 * Semantica:
 *  - `isSupportTeacher === true`  → docente di sostegno;
 *  - `isSupportTeacher === false` → docente curricolare;
 *  - `isSupportTeacher === undefined` (profilo legacy) → fallback in LETTURA:
 *    sostegno se `primarySubjects` contiene "sostegno", altrimenti curricolare.
 *
 * REGOLA FONDAMENTALE: un valore esplicito vince SEMPRE sull'euristica.
 * `{ isSupportTeacher: false, primarySubjects: ["Sostegno"] }` è un docente
 * CURRICOLARE. I vecchi pattern `flag || materia` sono vietati perché
 * trasformerbero un `false` esplicito in `true`.
 *
 * Funzione di sola lettura: non persiste né migra alcun dato; il flag viene
 * reso esplicito solo alla prima salvataggio consapevole dal Profilo.
 */

/** Euristica legacy: materia riconducibile a "sostegno". Usata SOLO col flag assente. */
const SUPPORT_SUBJECT_PATTERN = /sostegno/i;

export function isSupportTeacherOf(
  profile: Pick<TeacherProfile, "isSupportTeacher" | "primarySubjects"> | null | undefined,
): boolean {
  if (!profile) return false;
  if (profile.isSupportTeacher !== undefined) return profile.isSupportTeacher === true;
  return (profile.primarySubjects ?? []).some(subject => SUPPORT_SUBJECT_PATTERN.test(subject));
}
