const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

export function reconnectDelayMs(attempt: number): number | undefined {
  return RECONNECT_DELAYS_MS[attempt - 1];
}
