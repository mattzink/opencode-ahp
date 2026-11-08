/** Normalize an unknown thrown value to a loggable message. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
