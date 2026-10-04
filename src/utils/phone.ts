/**
 * Normaliza un celular ecuatoriano a 09XXXXXXXX.
 * Acepta "+593 99 701 1366", "593997011366", "997011366" y "0997011366".
 * Devuelve null si no es un celular válido.
 */
export function normalizeEcPhone(input: unknown): string | null {
  let digits = String(input ?? "").replace(/\D/g, "");
  if (digits.startsWith("593")) digits = digits.slice(3);
  if (digits.length === 9 && digits.startsWith("9")) digits = `0${digits}`;
  return /^09\d{8}$/.test(digits) ? digits : null;
}
