import { describe, expect, it } from "vitest";
import {
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelayMs,
  reconnectDelayWithJitter,
} from "./retry-policy.js";

describe("reconnect retry policy", () => {
  it("uses the approved capped exponential delays", () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBe(5);
    expect([1, 2, 3, 4, 5].map(reconnectDelayMs)).toEqual([
      500, 1_000, 2_000, 4_000, 8_000,
    ]);
  });

  it("has no retry outside the bounded attempt range", () => {
    expect(reconnectDelayMs(0)).toBeUndefined();
    expect(reconnectDelayMs(6)).toBeUndefined();
  });

  it("applies symmetric ±20% jitter around the nominal delay", () => {
    expect(reconnectDelayWithJitter(1, () => 0)).toBe(400);
    expect(reconnectDelayWithJitter(1, () => 0.5)).toBe(500);
    expect(reconnectDelayWithJitter(1, () => 1)).toBe(600);
  });

  it("clamps negative jitter at zero instead of producing a negative delay", () => {
    expect(reconnectDelayWithJitter(1, () => -1)).toBeGreaterThanOrEqual(0);
    expect(reconnectDelayWithJitter(1, () => 0)).toBeGreaterThanOrEqual(0);
  });

  it("returns undefined when the nominal delay is undefined", () => {
    expect(reconnectDelayWithJitter(6, () => 0.5)).toBeUndefined();
  });
});
