import { createRequire } from 'node:module';
import type { MePayload } from '../../../packages/core/src/types.js';

const { buildSignHeaders } = createRequire(import.meta.url)('../../../client-docker/src/signing.js');

export const API_VERSION = '5.1.0';

export async function callSignedApi<T = any>(method: string, url: string, body: unknown, credential: string): Promise<{ status: number; payload: T | null; error?: string }> {
  const rawBody = body === undefined || body === null ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'X-Client-Type': 'docker',
    ...buildSignHeaders(method, url, rawBody, credential),
    'X-Music-Helper-Version': API_VERSION,
  };
  if (credential) headers.Authorization = `Bearer ${credential}`;
  try {
    const response = await fetch(url, { method, headers, body: rawBody || undefined, signal: AbortSignal.timeout(15_000) });
    const payload = await response.json().catch(() => null);
    return { status: response.status, payload, error: response.ok ? undefined : String(payload?.error || `http_${response.status}`) };
  } catch { return { status: 0, payload: null, error: 'network_error' }; }
}

export function normalizeMe(payload: any): MePayload {
  const p = payload.participant || {};
  return {
    displayName: payload.user?.displayName || payload.user?.username || payload.displayName || '',
    credits: p.available_credits ?? p.credits ?? payload.credits ?? 0,
    helpedToday: p.help_seconds_used ?? payload.helpStats?.helped_seconds ?? 0,
    helpedLimit: p.help_seconds_limit ?? 9000,
    receivedToday: p.received_finished_count_24h ?? p.today_received_help_count ?? payload.helpStats?.received_count ?? 0,
    receivedLimit: p.today_received_limit ?? payload.limits?.dailyReceivedLimit ?? 26,
  };
}
