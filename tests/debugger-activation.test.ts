import { describe, expect, it } from "vitest";
import packageManifest from "../package.json";

describe("FoundryScript debugger activation", () => {
  it("preserves contributed entry points while activating for debugging", () => {
    expect(packageManifest.activationEvents).toEqual([
      "onLanguage:foundryscript",
      "onCommand:foundryScript.connectionActions",
      "onTaskType:foundryscript",
      "onDebugInitialConfigurations",
      "onDebugResolve:foundryscript",
      "workspaceContains:**/project.foundry",
    ]);
  });
});
