import { describe, expect, it } from "vitest";
import {
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelayMs,
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
});
