import { describe, expect, it } from "vitest";
import packageManifest from "../package.json";

describe("FoundryScript debugger activation", () => {
  it("activates before resolving or generating a debug configuration", () => {
    expect(packageManifest.activationEvents).toEqual(
      expect.arrayContaining([
        "onDebugInitialConfigurations",
        "onDebugResolve:foundryscript",
      ]),
    );
  });
});
