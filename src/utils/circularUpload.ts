const fileTypes = ['application/pdf','image/png','image/jpeg','image/webp'];
export function circularUploadError(file: Pick<File,'name'|'type'|'size'>): string | null {
  const isText = file.type === 'text/plain' || (!file.type && /\.txt$/i.test(file.name));
  if (!isText && !fileTypes.includes(file.type)) return 'Formato non supportato. Usa PDF, PNG, JPEG, WebP o un file TXT.';
  if (file.size > (isText ? 400_000 : 5 * 1024 * 1024)) return isText ? 'File di testo troppo grande (massimo 100.000 caratteri).' : 'Documento troppo grande: massimo 5 MB.';
  return null;
}
