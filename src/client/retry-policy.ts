const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

export function reconnectDelayMs(attempt: number): number | undefined {
  return RECONNECT_DELAYS_MS[attempt - 1];
}

// Jitter factor applied to the scheduled retry delay so multiple VS Code
// windows or supervisors do not stay in lockstep indefinitely when an engine
// is flapping. ±20% is small enough to keep the cadence recognizable but
// large enough to decorrelate concurrent restarters within a few attempts.
const JITTER_FACTOR = 0.2;

export function reconnectDelayWithJitter(
  attempt: number,
  random: () => number = Math.random,
): number | undefined {
  const baseDelayMs = reconnectDelayMs(attempt);
  if (baseDelayMs === undefined) {
    return undefined;
  }
  const jitter = baseDelayMs * JITTER_FACTOR * (random() * 2 - 1);
  return Math.max(0, Math.round(baseDelayMs + jitter));
}
