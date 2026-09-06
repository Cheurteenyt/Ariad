// v2/src/utils/error-message.ts
// Shared error-to-message formatting for CLI and UI error paths.

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}
