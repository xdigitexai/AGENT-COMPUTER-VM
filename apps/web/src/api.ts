export const API_BASE = (import.meta as any).env.VITE_API_URL ?? "/api/v1";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const { headers: extra, ...rest } = init ?? {};
  const headers: Record<string, string> = { ...(rest.body ? { "Content-Type": "application/json" } : {}), ...(extra as Record<string, string> | undefined) };
  const response = await fetch(`${API_BASE}${path}`, { credentials: "include", ...rest, headers });
  if (!response.ok) {
    const body: any = await response.json().catch(() => ({}));
    const fieldErrors: any = body && body.error && body.error.details ? body.error.details.fieldErrors : null;
    const first: any = fieldErrors && typeof fieldErrors === "object" ? Object.entries(fieldErrors).find((entry: any) => Array.isArray(entry[1]) && entry[1].length) : null;
    throw new Error(first ? `${first[0]}: ${first[1][0]}` : body && body.error && body.error.message ? body.error.message : `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
