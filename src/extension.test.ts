import { describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import { activate, deactivate } from "./extension.js";
import packageManifest from "../package.json";

describe("extension entry point", () => {
  it("activates without throwing", () => {
    const context = {
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    expect(() => activate(context)).not.toThrow();
  });

  it("deactivates without throwing", () => {
    expect(() => deactivate()).not.toThrow();
  });
});

describe("package.json manifest", () => {
  it("declares the foundryscript language for .fs files", () => {
    const [language] = packageManifest.contributes.languages;

    expect(language.id).toBe("foundryscript");
    expect(language.extensions).toContain(".fs");
  });

  it("registers a grammar scoped to source.foundryscript for the declared language", () => {
    const [language] = packageManifest.contributes.languages;
    const [grammar] = packageManifest.contributes.grammars;

    expect(grammar.scopeName).toBe("source.foundryscript");
    expect(grammar.language).toBe(language.id);
  });
});
