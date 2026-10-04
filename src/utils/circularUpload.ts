export const ALLOWED_CIRCULAR_MIMES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

export function normalizeCircularMimeType(type?: string, fileName?: string): string {
  const t = (type || '').trim().toLowerCase();
  if (t === 'application/pdf') return 'application/pdf';
  if (t === 'image/jpeg' || t === 'image/jpg' || t === 'image/pjpeg') return 'image/jpeg';
  if (t === 'image/png' || t === 'image/x-png') return 'image/png';
  if (t === 'image/webp') return 'image/webp';
  if (t === 'image/heic' || t === 'image/heic-sequence') return 'image/heic';
  if (t === 'image/heif' || t === 'image/heif-sequence') return 'image/heif';
  if (t === 'text/plain') return 'text/plain';

  if (fileName) {
    if (/\.pdf$/i.test(fileName)) return 'application/pdf';
    if (/\.jpe?g$/i.test(fileName)) return 'image/jpeg';
    if (/\.png$/i.test(fileName)) return 'image/png';
    if (/\.webp$/i.test(fileName)) return 'image/webp';
    if (/\.heic$/i.test(fileName)) return 'image/heic';
    if (/\.heif$/i.test(fileName)) return 'image/heif';
    if (/\.txt$/i.test(fileName)) return 'text/plain';
  }
  return t;
}

export function circularUploadError(file: Pick<File, 'name' | 'type' | 'size'>): string | null {
  const mime = normalizeCircularMimeType(file.type, file.name);
  const isText = mime === 'text/plain' || (!mime && /\.txt$/i.test(file.name));
  if (!isText && !ALLOWED_CIRCULAR_MIMES.includes(mime as typeof ALLOWED_CIRCULAR_MIMES[number])) {
    return 'Formato non supportato. Usa PDF, PNG, JPEG, WebP o un file TXT.';
  }
  if (file.size > (isText ? 400_000 : 5 * 1024 * 1024)) {
    return isText ? 'File di testo troppo grande (massimo 100.000 caratteri).' : 'Documento troppo grande: massimo 5 MB.';
  }
  return null;
}
