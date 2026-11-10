export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** HTTP statuses worth trying again later. */
export const retryableStatus = (status: number): boolean => status === 429 || status >= 500;

/** Parsed JSON, or undefined when [raw] is not JSON (provider error bodies are sometimes HTML). */
export function tryJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
