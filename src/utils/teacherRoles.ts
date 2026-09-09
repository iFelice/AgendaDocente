import type { TeacherRole, TeacherRoleKind } from "../types";

/** Human-readable Italian labels for every assignable teacher role. */
export const ROLE_LABELS: Record<TeacherRoleKind, string> = {
  coordinatore: "Coordinatore di classe",
  segretario: "Segretario verbaliente",
  tutor: "Tutor / PCTO",
  referente: "Referente di progetto",
  docente_sostegno: "Docente di sostegno",
  referente_inclusione: "Funzione strumentale Inclusione",
  membro_gli: "Membro GLI",
  animatore_digitale: "Animatore digitale",
  team_digitale: "Team per l'innovazione digitale",
  referente_bes_dsa: "Referente BES/DSA",
  referente_bullismo: "Referente bullismo/cyberbullismo",
  referente_orientamento: "Referente orientamento",
  referente_uscite_viaggi: "Referente uscite/viaggi",
  collaboratore_dirigente: "Collaboratore dello staff di dirigenza",
  altro: "Altro ruolo personalizzato",
};

/** Roles proposed during onboarding as *optional* add-ons, in display order. */
export const ONBOARDING_ADDITIONAL_ROLES: TeacherRoleKind[] = [
  "coordinatore",
  "animatore_digitale",
  "team_digitale",
  "referente_inclusione",
  "referente_bes_dsa",
  "referente_bullismo",
  "referente_orientamento",
  "referente_uscite_viaggi",
  "membro_gli",
  "collaboratore_dirigente",
];

/** The support-teacher technical role is derived from the teacher type, not invented. */
export const SUPPORT_TECHNICAL_ROLE: TeacherRole = {
  role: "docente_sostegno",
  description: "Docente specializzato per il sostegno didattico",
};

export function roleDisplayName(role: TeacherRole): string {
  const label = role.role === "altro" && role.label?.trim() ? role.label.trim() : ROLE_LABELS[role.role] ?? role.role;
  return role.targetClass ? `${label} — classe ${role.targetClass}` : label;
}

export interface OnboardingRoleChoice {
  role: TeacherRoleKind;
  targetClass?: string;
  /** Custom label for role === "altro". */
  label?: string;
}

/**
 * Build `TeacherProfile.roles` exclusively from explicit user choices.
 * A support teacher gets the technical `docente_sostegno` role (mirrors isSupportTeacher);
 * this never implies GLI membership, and a curricolare teacher is never auto-marked coordinatore.
 */
export function buildRolesFromChoices(input: {
  isSupportTeacher: boolean;
  additionalRoles: OnboardingRoleChoice[];
}): TeacherRole[] {
  const roles: TeacherRole[] = [];
  if (input.isSupportTeacher) roles.push({ ...SUPPORT_TECHNICAL_ROLE });
  for (const choice of input.additionalRoles) {
    if (!choice || !choice.role) continue;
    if (choice.role === "docente_sostegno") {
      if (!input.isSupportTeacher) roles.push({ role: "docente_sostegno", description: "Docente specializzato per il sostegno didattico" });
      continue;
    }
    const targetClass = choice.targetClass?.trim().toUpperCase() || undefined;
    const label = choice.role === "altro" ? choice.label?.trim() || "" : undefined;
    if (choice.role === "altro" && !label) continue;
    const role: TeacherRole = {
      role: choice.role,
      ...(targetClass ? { targetClass } : {}),
      ...(label ? { label } : {}),
      description: label || ROLE_LABELS[choice.role] || choice.role,
    };
    const duplicate = roles.some(r => r.role === role.role && (r.targetClass || "") === (targetClass || "") && (r.label || "") === (label || ""));
    if (!duplicate) roles.push(role);
  }
  return roles;
}

/** Normalize raw stored roles (older installs may contain strings or unknown kinds). */
export function normalizeTeacherRoles(value: unknown): TeacherRole[] {
  if (!Array.isArray(value)) return [];
  const valid = new Set<string>(Object.keys(ROLE_LABELS));
  return value
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .filter(r => typeof r.role === "string" && valid.has(r.role))
    .map(r => ({
      role: r.role as TeacherRoleKind,
      ...(typeof r.targetClass === "string" && r.targetClass.trim() ? { targetClass: r.targetClass.trim() } : {}),
      ...(typeof r.description === "string" && r.description.trim() ? { description: r.description.trim() } : {}),
      ...(typeof r.label === "string" && r.label.trim() ? { label: r.label.trim() } : {}),
    }));
}
