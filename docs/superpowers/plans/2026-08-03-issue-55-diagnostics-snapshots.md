# Diagnostics Source Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LSP/CLI diagnostic transitions use authoritative source snapshots so clean lint reports reliably clear stale Problems entries.

**Architecture:** The diagnostics unit remains the single `DiagnosticCollection` owner and gains a complete-snapshot operation in addition to per-URI updates. It retains source-specific maps and projects only the active source, with explicit transition behavior that preserves last-known diagnostics until an authoritative replacement is available. The CLI publisher emits exactly one complete snapshot for each accepted lint report and no longer tracks cleanup URIs itself.

**Tech Stack:** strict TypeScript, VS Code `DiagnosticCollection`, Vitest.

---

### Task 1: Define source snapshot behavior test-first

**Files:**
- Modify: `src/diagnostics/index.ts`
- Modify: `src/diagnostics/index.test.ts`

- [ ] **Step 1: Add the failing regression tests**

Add a `replace` helper to the diagnostics test harness and write these four tests in `src/diagnostics/index.test.ts`:

```ts
it("projects a clean CLI snapshot after disconnect", () => {
  const { collection, unit } = createHarness(true);
  const uri = fakeUri("file:///player.fs");
  unit.accept({ source: "lsp", uri, diagnostics: [fakeDiagnostic("lsp")] });
  unit.replace({ source: "cli", entries: [] });
  expect(labelsAt(collection, uri)).toEqual(["lsp"]);
  unit.setLanguageServerConnected(false);
  expect(collection.has(uri)).toBe(false);
});

it("retains LSP diagnostics without a CLI snapshot until a clean report arrives", () => {
  const { collection, unit } = createHarness(true);
  const uri = fakeUri("file:///player.fs");
  unit.accept({ source: "lsp", uri, diagnostics: [fakeDiagnostic("lsp")] });
  unit.setLanguageServerConnected(false);
  expect(labelsAt(collection, uri)).toEqual(["lsp"]);
  unit.replace({ source: "cli", entries: [] });
  expect(collection.has(uri)).toBe(false);
});

it("retains only the latest complete CLI snapshot while LSP is connected", () => {
  const { collection, unit } = createHarness(true);
  const lspUri = fakeUri("file:///lsp.fs");
  const cliUri = fakeUri("file:///cli.fs");
  unit.accept({ source: "lsp", uri: lspUri, diagnostics: [fakeDiagnostic("lsp")] });
  unit.replace({ source: "cli", entries: [{ uri: cliUri, diagnostics: [fakeDiagnostic("cli")] }] });
  unit.replace({ source: "cli", entries: [] });
  expect(labelsAt(collection, lspUri)).toEqual(["lsp"]);
  unit.setLanguageServerConnected(false);
  expect(collection.visible.size).toBe(0);
});

it("keeps CLI visible during reconnect and restores its snapshot on disconnect", () => {
  const { collection, unit } = createHarness();
  const uri = fakeUri("file:///player.fs");
  unit.replace({ source: "cli", entries: [{ uri, diagnostics: [fakeDiagnostic("cli")] }] });
  unit.setLanguageServerConnected(true);
  expect(labelsAt(collection, uri)).toEqual(["cli"]);
  unit.accept({ source: "lsp", uri, diagnostics: [fakeDiagnostic("lsp")] });
  expect(labelsAt(collection, uri)).toEqual(["lsp"]);
  unit.setLanguageServerConnected(false);
  expect(labelsAt(collection, uri)).toEqual(["cli"]);
});
```

Also preserve the existing tests for active-source filtering, per-URI clears, and single collection disposal.

- [ ] **Step 2: Run RED**

Run: `npx vitest run src/diagnostics/index.test.ts`

Expected: FAIL because `unit.replace` is not a function in the pre-fix implementation.

- [ ] **Step 3: Add snapshot types and implementation**

In `src/diagnostics/index.ts`, add:

```ts
export interface DiagnosticEntry {
  readonly uri: vscode.Uri;
  readonly diagnostics: readonly vscode.Diagnostic[];
}

export interface SourcedDiagnosticsSnapshot {
  readonly source: DiagnosticSource;
  readonly entries: readonly DiagnosticEntry[];
}
```

Make `SourcedDiagnostics` extend `DiagnosticEntry`, add `replace(snapshot)` to `DiagnosticsUnit`, and implement maps keyed by `uri.toString()`:

```ts
const snapshots: Record<DiagnosticSource, Map<string, DiagnosticEntry>> = {
  lsp: new Map(),
  cli: new Map(),
};
const visibleUris = new Map<string, vscode.Uri>();
let cliSnapshotReceived = false;

function store(map: Map<string, DiagnosticEntry>, entry: DiagnosticEntry): void {
  const key = entry.uri.toString();
  if (entry.diagnostics.length === 0) map.delete(key);
  else map.set(key, entry);
}

function publish(entry: DiagnosticEntry): void {
  const key = entry.uri.toString();
  if (entry.diagnostics.length === 0) {
    collection.delete(entry.uri);
    visibleUris.delete(key);
  } else {
    collection.set(entry.uri, entry.diagnostics);
    visibleUris.set(key, entry.uri);
  }
}

function project(snapshot: ReadonlyMap<string, DiagnosticEntry>): void {
  for (const [key, uri] of visibleUris) {
    if (!snapshot.has(key)) {
      collection.delete(uri);
      visibleUris.delete(key);
    }
  }
  for (const entry of snapshot.values()) publish(entry);
}
```

Implement the public operations with these rules:

```ts
accept(update): void {
  if (update.source === "lsp" && !languageServerConnected) return;
  store(snapshots[update.source], update);
  const activeSource = languageServerConnected ? "lsp" : "cli";
  if (update.source === activeSource) publish(update);
},
replace(snapshot): void {
  const replacement = new Map<string, DiagnosticEntry>();
  for (const entry of snapshot.entries) store(replacement, entry);
  snapshots[snapshot.source] = replacement;
  if (snapshot.source === "cli") cliSnapshotReceived = true;
  const activeSource = languageServerConnected ? "lsp" : "cli";
  if (snapshot.source === activeSource) project(replacement);
},
setLanguageServerConnected(connected): void {
  if (languageServerConnected === connected) return;
  languageServerConnected = connected;
  if (connected) snapshots.lsp.clear();
  else if (cliSnapshotReceived) project(snapshots.cli);
},
```

- [ ] **Step 4: Run GREEN**

Run: `npx vitest run src/diagnostics/index.test.ts`

Expected: all diagnostics arbitration tests pass.

- [ ] **Step 5: Commit the diagnostics state model**

```bash
git add src/diagnostics/index.ts src/diagnostics/index.test.ts
git commit -m "fix: retain source-specific diagnostic snapshots"
```

### Task 2: Publish complete CLI lint snapshots test-first

**Files:**
- Modify: `src/tasks/lint-diagnostics.ts`
- Modify: `src/tasks/lint-diagnostics.test.ts`

- [ ] **Step 1: Change the test harness and write failing expectations**

In `src/tasks/lint-diagnostics.test.ts`, make `createHarness()` expose both `accept` and `replace` spies and satisfy the new interface:

```ts
const replace = vi.fn<(snapshot: SourcedDiagnosticsSnapshot) => void>();
const unit: DiagnosticsUnit = {
  accept: (update) => accept(update),
  replace: (snapshot) => replace(snapshot),
  setLanguageServerConnected: vi.fn(),
  dispose: vi.fn(),
};
```

Update the accepted-report test to assert one replacement with two entries and no `accept` calls. Update the clean-rerun test to assert:

```ts
expect(replace).toHaveBeenLastCalledWith({ source: "cli", entries: [] });
expect(accept).not.toHaveBeenCalled();
```

For exit 2, cancellation, supersession, and malformed JSON, clear both spies before the invalid run and assert neither spy was called.

- [ ] **Step 2: Run RED**

Run: `npx vitest run src/tasks/lint-diagnostics.test.ts`

Expected: FAIL because the publisher still calls per-URI `accept` and tracks `previousUris`.

- [ ] **Step 3: Replace publisher cleanup tracking**

In `src/tasks/lint-diagnostics.ts`, remove `previousUris`. Keep report parsing and diagnostic conversion unchanged. Replace the per-batch publish/cleanup loops with exactly one complete snapshot call:

```ts
this.diagnostics.replace({
  source: "cli",
  entries: [...batches.values()],
});
```

- [ ] **Step 4: Run GREEN for both subsystems**

Run:

```bash
npx vitest run src/diagnostics/index.test.ts src/tasks/lint-diagnostics.test.ts
npm run typecheck
npm run lint
```

Expected: focused tests, strict typecheck, and lint all pass.

- [ ] **Step 5: Commit the publisher integration**

```bash
git add src/tasks/lint-diagnostics.ts src/tasks/lint-diagnostics.test.ts
git commit -m "fix: publish authoritative CLI diagnostic snapshots"
```

### Task 3: Full verification and self-review

**Files:**
- Review: `src/diagnostics/index.ts`
- Review: `src/diagnostics/index.test.ts`
- Review: `src/tasks/lint-diagnostics.ts`
- Review: `src/tasks/lint-diagnostics.test.ts`

- [ ] **Step 1: Run the required repository gate**

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

Expected: every command exits 0. If the known 20 ms host-launcher timing test flakes, rerun that focused test five times and the full suite once; do not modify unrelated host-launcher code under this issue.

- [ ] **Step 2: Inspect scope and acceptance coverage**

Run:

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short
```

Expected: only the plan and four diagnostics/lint files changed; no whitespace errors; clean worktree.

- [ ] **Step 3: Report implementation evidence**

Return DONE, DONE_WITH_CONCERNS, NEEDS_CONTEXT, or BLOCKED. Include commit SHAs, RED/GREEN output, full verification counts, and a criterion-by-criterion self-review. Do not push or open a pull request.
