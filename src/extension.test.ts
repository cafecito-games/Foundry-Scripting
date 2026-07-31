import { describe, expect, it } from "vitest";
import { activate, deactivate } from "./extension.js";

describe("extension entry point", () => {
  it("activates without throwing", () => {
    expect(() => activate({} as never)).not.toThrow();
  });

  it("deactivates without throwing", () => {
    expect(() => deactivate()).not.toThrow();
  });
});
