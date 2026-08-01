# Workspace Project Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve one validated Foundry project for wrapper workspaces and use it consistently for LSP startup, CLI tasks, and Test Explorer.

**Architecture:** Add a pure shared resolver under `src/project/` plus a thin VS Code adapter that reads `foundryScript.projectPath`, checks manifests, and performs scoped discovery. Inject the adapter's resolver function into LSP activation, the task provider, and testing configuration so each subsystem resolves only when it needs Foundry tooling.

**Tech Stack:** TypeScript 5.6 in strict Node16 mode, VS Code 1.90 extension APIs, Node `path`/`fs/promises`, Vitest 2.1, esbuild, ESLint.

---

## File structure

- Create `src/project/resolver.ts`: pure selection policy, typed results, stable messages.
- Create `src/project/resolver.test.ts`: exhaustive policy and failure tests.
- Create `src/project/workspace.ts`: VS Code configuration/filesystem adapter.
- Create `src/project/workspace.test.ts`: adapter scope, setting, exclusion, and filesystem tests.
- Modify `src/extension.ts` and `src/extension.test.ts`: LSP and testing integration.
- Modify `src/tasks/provider.ts` and `src/tasks/provider.test.ts`: asynchronous task resolution.
- Modify `src/testing/adapter.ts`, `src/testing/runtime.ts`, and `src/testing/runtime.test.ts`: retain typed project-resolution failures before negotiation.
- Modify `package.json`, `README.md`, and `src/extension.test.ts`: setting and user documentation.

### Task 1: Pure project-selection policy

**Files:**
- Create: `src/project/resolver.ts`
- Create: `src/project/resolver.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Create table-driven tests using injected `manifestExists` and `findManifests` functions. The tests must cover configured absolute and relative paths, configured-path precedence, invalid configuration without fallback, root precedence over nested manifests, one nested project, no projects, sorted/deduplicated ambiguity candidates, and filesystem rejection.

```typescript
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveFoundryProject } from "./resolver.js";

describe("Foundry project resolver", () => {
  it("resolves one nested project when the workspace root is not a project", async () => {
    const result = await resolveFoundryProject({
      workspacePath: "/workspace/repository",
      configuredPath: "",
      manifestExists: vi.fn().mockResolvedValue(false),
      findManifests: vi.fn().mockResolvedValue([
        "/workspace/repository/test_project/project.foundry",
      ]),
    });

    expect(result).toEqual({
      success: true,
      project: "/workspace/repository/test_project",
    });
  });

  it("requires configuration for multiple nested projects", async () => {
    const result = await resolveFoundryProject({
      workspacePath: "/workspace/repository",
      configuredPath: "",
      manifestExists: vi.fn().mockResolvedValue(false),
      findManifests: vi.fn().mockResolvedValue([
        "/workspace/repository/zeta/project.foundry",
        "/workspace/repository/alpha/project.foundry",
        "/workspace/repository/alpha/project.foundry",
      ]),
    });

    expect(result).toMatchObject({
      success: false,
      failure: {
        kind: "ambiguous_projects",
        setting: "foundryScript.projectPath",
        candidates: ["alpha/project.foundry", "zeta/project.foundry"],
      },
    });
  });

  it("resolves a relative configured directory from the workspace", async () => {
    const manifestExists = vi.fn().mockResolvedValue(true);
    const result = await resolveFoundryProject({
      workspacePath: "/workspace/repository",
      configuredPath: "test_project",
      manifestExists,
      findManifests: vi.fn(),
    });

    expect(manifestExists).toHaveBeenCalledWith(
      path.join("/workspace/repository", "test_project"),
    );
    expect(result).toEqual({
      success: true,
      project: path.join("/workspace/repository", "test_project"),
    });
  });
});
```

- [ ] **Step 2: Run the resolver test and verify RED**

Run: `npx vitest run src/project/resolver.test.ts`

Expected: FAIL because `src/project/resolver.ts` does not exist.

- [ ] **Step 3: Implement the typed resolver**

Implement this public surface and keep every expected failure in the result union:

```typescript
export const PROJECT_PATH_SETTING = "foundryScript.projectPath";

export type ProjectResolutionFailureKind =
  | "missing_workspace"
  | "invalid_configured_project"
  | "project_not_found"
  | "ambiguous_projects"
  | "filesystem_error";

export interface ProjectResolutionFailure {
  readonly kind: ProjectResolutionFailureKind;
  readonly message: string;
  readonly setting?: typeof PROJECT_PATH_SETTING;
  readonly candidates?: readonly string[];
  readonly cause?: unknown;
}

export type ProjectResolution =
  | { readonly success: true; readonly project: string }
  | { readonly success: false; readonly failure: ProjectResolutionFailure };

export interface FoundryProjectResolutionRequest {
  readonly workspacePath: string | undefined;
  readonly configuredPath: string;
  readonly manifestExists: (project: string) => Promise<boolean>;
  readonly findManifests: (workspace: string) => Promise<readonly string[]>;
}

export async function resolveFoundryProject(
  request: FoundryProjectResolutionRequest,
): Promise<ProjectResolution>;
```

The implementation must resolve configured paths before discovery, check the root before calling `findManifests`, normalize manifest parents with `path.resolve`, deduplicate them, sort relative manifest paths, and wrap rejected filesystem operations as `filesystem_error` with `cause`.

- [ ] **Step 4: Verify GREEN and strict types**

Run: `npx vitest run src/project/resolver.test.ts && npm run typecheck`

Expected: resolver tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the resolver**

```bash
git add src/project/resolver.ts src/project/resolver.test.ts
git commit -m "feat: resolve Foundry projects deterministically"
```

### Task 2: VS Code workspace adapter and configuration contribution

**Files:**
- Create: `src/project/workspace.ts`
- Create: `src/project/workspace.test.ts`
- Modify: `package.json`
- Modify: `src/extension.test.ts`

- [ ] **Step 1: Write failing adapter and manifest tests**

Mock `vscode.workspace.workspaceFolders`, `getConfiguration`, and `findFiles`. Inject `manifestExists` where filesystem behavior is not under test.

```typescript
it("reads projectPath and searches only under the first workspace folder", async () => {
  workspaceMock.configuration.set("projectPath", "");
  workspaceMock.workspaceFolders.push(
    { uri: { fsPath: "/workspace/first" } },
    { uri: { fsPath: "/workspace/second" } },
  );
  workspaceMock.findFiles.mockResolvedValue([
    { fsPath: "/workspace/first/test_project/project.foundry" },
  ]);
  const resolveProject = createWorkspaceProjectResolver({
    manifestExists: vi.fn().mockResolvedValue(false),
  });

  await expect(resolveProject()).resolves.toEqual({
    success: true,
    project: "/workspace/first/test_project",
  });
  expect(workspaceMock.findFiles).toHaveBeenCalledWith(
    expect.objectContaining({
      base: "/workspace/first",
      pattern: "**/project.foundry",
    }),
    expect.stringContaining("node_modules"),
  );
});
```

Add this assertion to the manifest test in `src/extension.test.ts`:

```typescript
expect(properties["foundryScript.projectPath"]).toMatchObject({
  type: "string",
  default: "",
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run src/project/workspace.test.ts src/extension.test.ts`

Expected: FAIL because the workspace adapter and contributed setting do not exist.

- [ ] **Step 3: Implement the adapter**

Export a reusable resolver function type and factory:

```typescript
export type ResolveWorkspaceProject = () => Promise<ProjectResolution>;

export interface WorkspaceProjectResolverOptions {
  readonly manifestExists?: (project: string) => Promise<boolean>;
}

export function createWorkspaceProjectResolver(
  options: WorkspaceProjectResolverOptions = {},
): ResolveWorkspaceProject;
```

The default manifest check uses `access(path.join(project, "project.foundry"))`, returns false only for `ENOENT`/`ENOTDIR`, and rethrows permission or I/O errors. Discovery uses:

```typescript
vscode.workspace.findFiles(
  new vscode.RelativePattern(workspacePath, "**/project.foundry"),
  "**/{.git,.foundry,node_modules,build,dist,foundryscript-test-*}/**",
);
```

Add `foundryScript.projectPath` next to `foundryScript.enginePath` in `package.json`, with an empty default and a description covering relative paths, root preference, single nested discovery, and explicit selection for ambiguity.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/project/resolver.test.ts src/project/workspace.test.ts src/extension.test.ts && npm run typecheck`

Expected: all focused tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit the adapter and setting**

```bash
git add src/project/workspace.ts src/project/workspace.test.ts package.json src/extension.test.ts
git commit -m "feat: configure workspace Foundry project"
```

### Task 3: Resolve projects before task processes

**Files:**
- Modify: `src/tasks/provider.ts`
- Modify: `src/tasks/provider.test.ts`

- [ ] **Step 1: Write failing task-provider tests**

Inject `resolveProject` through `FoundryTaskProviderOptions`. Prove a nested result reaches both `--project` and `cwd`, and an ambiguity failure writes one terminal error, opens project settings, closes 1, and never calls `spawnProcess`.

```typescript
it("uses the shared resolved project for the command and cwd", async () => {
  const child = new FakeChildProcess();
  const spawnProcess = vi.fn(() => child.asChildProcess());
  const provider = new FoundryTaskProvider({
    spawnProcess,
    resolveProject: vi.fn().mockResolvedValue({
      success: true,
      project: "/workspace/repository/test_project",
    }),
  });
  const [task] = provider.provideTasks();
  const terminal = await taskTerminal(task);

  terminal.open(undefined);
  await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());

  expect(spawnProcess).toHaveBeenCalledWith(
    "foundry",
    [
      "project",
      "import",
      "--project",
      "/workspace/repository/test_project",
    ],
    expect.objectContaining({ cwd: "/workspace/repository/test_project" }),
  );
});

it("does not spawn when project selection is ambiguous", async () => {
  const spawnProcess = vi.fn();
  const provider = new FoundryTaskProvider({
    spawnProcess,
    resolveProject: vi.fn().mockResolvedValue({
      success: false,
      failure: {
        kind: "ambiguous_projects",
        message: "Multiple Foundry projects were found: a/project.foundry, b/project.foundry.",
        setting: "foundryScript.projectPath",
        candidates: ["a/project.foundry", "b/project.foundry"],
      },
    }),
  });
  const [task] = provider.provideTasks();
  const terminal = await taskTerminal(task);
  const closes: Array<number | void> = [];
  terminal.onDidClose?.((code) => closes.push(code));

  terminal.open(undefined);
  await vi.waitFor(() => expect(closes).toEqual([1]));

  expect(spawnProcess).not.toHaveBeenCalled();
  expect(providerMock.showErrorMessage).toHaveBeenCalledWith(
    expect.stringContaining("Multiple Foundry projects"),
    "Open Settings",
  );
});
```

- [ ] **Step 2: Run the provider test and verify RED**

Run: `npx vitest run src/tasks/provider.test.ts`

Expected: FAIL because the provider ignores `resolveProject` and uses the workspace root.

- [ ] **Step 3: Implement asynchronous task resolution**

Extend `FoundryTaskProviderOptions` with:

```typescript
readonly resolveProject?: ResolveWorkspaceProject;
```

Store the default from `createWorkspaceProjectResolver()`. Change `open()` to start one private asynchronous method:

```typescript
open(): void {
  void this.start();
}

private async start(): Promise<void> {
  const resolution = await this.resolveProject();
  if (!resolution.success) {
    this.reportProjectFailure(resolution.failure);
    this.closeEmitter.fire(1);
    return;
  }
  // Build the existing command with project: resolution.project, then start it.
}
```

Map `missing_workspace` to **Open Folder**, failures with `setting` to **Open Settings**, and `filesystem_error` to a plain error dialog. Catch unexpected resolver rejection, write it to the terminal, close 1, and do not spawn.

Update `registerFoundryTaskProvider` so extension activation may inject the same `ResolveWorkspaceProject` function used by LSP and testing.

- [ ] **Step 4: Verify GREEN and lint**

Run: `npx vitest run src/tasks/provider.test.ts && npm run typecheck && npm run lint`

Expected: provider tests PASS; typecheck and lint exit 0.

- [ ] **Step 5: Commit task integration**

```bash
git add src/tasks/provider.ts src/tasks/provider.test.ts
git commit -m "fix: resolve projects before Foundry tasks"
```

### Task 4: Preserve project failures in testing runtime

**Files:**
- Modify: `src/testing/adapter.ts`
- Modify: `src/testing/runtime.ts`
- Modify: `src/testing/runtime.test.ts`

- [ ] **Step 1: Write a failing runtime test**

Add `"invalid_project"` to `TestAdapterFailureKind`, allow an optional preflight failure on testing configuration, and test that it becomes the current error without negotiation:

```typescript
it("publishes a project preflight failure without negotiating", async () => {
  const failure = new TestAdapterFailure(
    "invalid_project",
    "Multiple Foundry projects were found.",
    { setting: "foundryScript.projectPath" },
  );

  await runtime.configure({
    ...baseConfiguration,
    enabled: true,
    project: undefined,
    projectFailure: failure,
  });

  expect(options.negotiate).not.toHaveBeenCalled();
  expect(options.onClear).toHaveBeenCalled();
  expect(options.onState).toHaveBeenLastCalledWith({ kind: "error", failure });
  expect(runtime.readyContext()).toBeUndefined();
});
```

- [ ] **Step 2: Run the runtime test and verify RED**

Run: `npx vitest run src/testing/runtime.test.ts`

Expected: FAIL because `projectFailure` is not part of configuration and negotiation still starts.

- [ ] **Step 3: Implement preflight failure handling**

Extend `TestingRuntimeConfiguration`:

```typescript
readonly projectFailure?: TestAdapterFailure;
```

After disabled handling but before publishing `negotiating`, abort the prior generation, clear ready context and discovery, and publish `{ kind: "error", failure: configuration.projectFailure }`. Include failure kind, setting, and message in `configurationKey`; omit `projectFailure` from every ready configuration produced by `configurationFor`.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/testing/runtime.test.ts src/testing/adapter.test.ts && npm run typecheck`

Expected: testing tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit testing preflight support**

```bash
git add src/testing/adapter.ts src/testing/runtime.ts src/testing/runtime.test.ts
git commit -m "fix: retain testing project preflight failures"
```

### Task 5: Wire the resolver into LSP activation and Test Explorer

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/extension.test.ts`

- [ ] **Step 1: Write failing LSP integration tests**

Mock `createWorkspaceProjectResolver` to return `extensionMock.resolveProject`. Add tests proving attach uses `/workspace/repository/test_project`, off mode never resolves, and ambiguity prevents manager creation while offering project settings.

```typescript
it("starts the language client with the resolved nested project", async () => {
  extensionMock.resolveProject.mockResolvedValue({
    success: true,
    project: "/workspace/repository/test_project",
  });
  extensionMock.workspaceFolders.push({
    uri: { fsPath: "/workspace/repository" },
  });

  await activate(createContext());

  expect(extensionMock.createConnectionManager).toHaveBeenCalledWith(
    extensionMock.outputChannel,
    "/workspace/repository/test_project",
    expect.any(Function),
    extensionMock.diagnosticsUnit,
  );
  expect(extensionMock.start).toHaveBeenCalledWith(
    expect.objectContaining({
      project: "/workspace/repository/test_project",
    }),
  );
});

it("does not resolve a project when LSP and testing are off", async () => {
  extensionMock.configuration.set("lsp.mode", "off");

  await activate(createContext());

  expect(extensionMock.resolveProject).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write failing testing integration tests**

Enable testing and prove resolution feeds configuration/watchers. Then return an ambiguity failure and prove `projectFailure.kind === "invalid_project"`, negotiation does not start, and the **Open Settings** action targets `foundryScript.projectPath`. Add `foundryScript.projectPath` to the configuration-change test and verify it causes re-resolution.

```typescript
expect(extensionMock.testingConfigure).toHaveBeenCalledWith(
  expect.objectContaining({
    enabled: true,
    project: "/workspace/repository/test_project",
  }),
);
expect(extensionMock.watchers[0]?.pattern).toEqual(
  expect.objectContaining({ base: "/workspace/repository/test_project" }),
);
```

- [ ] **Step 3: Run extension tests and verify RED**

Run: `npx vitest run src/extension.test.ts`

Expected: FAIL because activation and testing still use `workspaceFolders[0]`.

- [ ] **Step 4: Implement shared wiring and race-safe testing configuration**

Create one resolver in `activate()` and inject it into tasks and testing:

```typescript
const resolveProject = createWorkspaceProjectResolver();
registerFoundryTaskProvider(context, diagnostics, resolveProject);
await registerTestingRuntime(context, resolveProject);
```

For LSP modes other than off, await the resolver before creating the manager. Log a stable `lsp.project.resolution_failed` event and present **Open Folder**, **Open Settings**, or a plain error according to the typed failure.

Make testing `configure()` asynchronous and generation-guarded so a slow old resolution cannot overwrite a newer settings/workspace change. Disabled testing skips resolution. Successful resolution sets `project`; failed resolution sets `project: undefined` and maps the typed failure to:

```typescript
new TestAdapterFailure(
  failure.kind === "missing_workspace" ? "missing_project" : "invalid_project",
  failure.message,
  {
    ...(failure.setting === undefined ? {} : { setting: failure.setting }),
    ...(failure.cause === undefined ? {} : { cause: failure.cause }),
  },
);
```

Add `foundryScript.projectPath` to `TESTING_CONFIGURATION_SECTIONS`. Await the initial testing configuration during activation; configuration and workspace event handlers invoke it with `void configure()` and keep existing failure deduplication.

- [ ] **Step 5: Verify GREEN and all focused integration tests**

Run: `npx vitest run src/extension.test.ts src/tasks/provider.test.ts src/testing/runtime.test.ts src/project/*.test.ts && npm run typecheck && npm run lint`

Expected: focused tests PASS; typecheck and lint exit 0.

- [ ] **Step 6: Commit extension integration**

```bash
git add src/extension.ts src/extension.test.ts
git commit -m "fix: use resolved project across extension tooling"
```

### Task 6: Document behavior and run complete verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the project-selection documentation**

After the language-server mode paragraph, document the exact selection order and wrapper example:

````markdown
### Selecting the Foundry project

The extension first checks `foundryScript.projectPath`. Relative values are
resolved from the first workspace folder. Without that setting, a workspace-root
`project.foundry` wins; otherwise, the extension automatically selects exactly
one nested `project.foundry`.

Wrapper repositories can select their project explicitly:

```json
{
  "foundryScript.projectPath": "test_project"
}
```

If multiple nested projects exist, configure `foundryScript.projectPath`. The
extension currently operates one Foundry project per VS Code window.
````

- [ ] **Step 2: Run all required verification from a clean install**

Run exactly:

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

Expected: every command exits 0; Vitest reports no failing files/tests and every grammar fixture succeeds.

- [ ] **Step 3: Reproduce the original workspace layout manually**

Package or launch the extension in an Extension Development Host, open `/Users/christian/CafecitoGames/FoundryObservability`, and inspect `FoundryScript LSP`. Expected launch arguments contain:

```text
--project /Users/christian/CafecitoGames/FoundryObservability/test_project
```

Expected: a `FOUNDRY_TOOLING` readiness record is logged and no inactivity timeout is shown. The known missing `FoundrySwift.framework` diagnostic may still appear but does not prevent tooling readiness.

- [ ] **Step 4: Review scope and repository state**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate -8
```

Expected: no whitespace errors, only intentional files changed, and commits are limited to design, plan, resolver, configuration, task/testing/LSP integration, and documentation.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain Foundry project selection"
```
