/** Escapa texto del usuario antes de usarlo en un RegExp de búsqueda. */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
