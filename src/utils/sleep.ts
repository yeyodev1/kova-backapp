/** Pausa entre llamadas en serie para no chocar con el rate limit de APIs externas. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
