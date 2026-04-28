/**
 * Thin fetch wrapper. The Worker is same-origin, so no base URL is needed.
 * REST surface is described in SPEC §8; this file holds typed helpers as the
 * surface fills out across milestones.
 */

export type ApiError = {
  error: {
    code: string;
    message: string;
  };
};

export type MeResponse =
  | { setupRequired: true; hint: string }
  | { setupRequired?: false; email: string; displayName: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    credentials: 'include',
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = body as ApiError | null;
    throw new Error(err?.error?.message ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export const api = {
  me: () => request<MeResponse>('/api/me'),
};
