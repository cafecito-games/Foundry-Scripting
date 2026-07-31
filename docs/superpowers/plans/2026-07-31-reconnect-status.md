# Reconnect With Backoff and Visible Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded reconnect with deterministic exponential backoff, truthful always-visible status, immediate manual reconnect, and open-document resynchronization after server loss.

**Architecture:** `ConnectionManager` remains the sole client/host lifecycle owner and gains a generation-guarded retry state machine driven by a pure retry policy and injectable scheduler. `FoundryScriptLanguageClient` reports unexpected stops while suppressing its library's implicit restart. A separate status controller renders immutable manager states and dispatches reconnect/log/settings actions.

**Tech Stack:** TypeScript, VS Code extension API, `vscode-languageclient` 9, Node timers/TCP, Vitest fake timers, ESLint, esbuild, vsce.

---

## File structure

- Create `src/client/retry-policy.ts`: fixed retry delay policy with bounded attempt lookup.
- Create `src/client/retry-policy.test.ts`: exact policy and exhaustion tests.
- Modify `src/client/language-client.ts`: disable implicit restart and expose unexpected-stop subscription.
- Modify `src/client/language-client.test.ts`: prove close policy and state transition filtering.
- Modify `src/client/connection-manager.ts`: connection states, timer/generation guards, retry/manual reconnect, and resource cleanup.
- Modify `src/client/connection-manager.test.ts`: deterministic loss/retry/ownership/resync behavior.
- Create `src/client/connection-status.ts`: state rendering and click action controller.
- Create `src/client/connection-status.test.ts`: rendering and action tests.
- Modify `src/client/runtime.ts`: compose scheduler, logging, and state callback.
- Modify `src/client/runtime.test.ts`: verify the real composition seams.
- Modify `src/extension.ts`: always-visible item, command registration, state wiring, and disposal.
- Modify `src/extension.test.ts`: off/no-attempt, actions, activation, and disposal integration.
- Modify `README.md`: document reconnect/status behavior and click actions.

### Task 1: Pure bounded retry policy

**Files:**
- Create: `src/client/retry-policy.ts`
- Create: `src/client/retry-policy.test.ts`

- [ ] **Step 1: Write the failing policy tests**

```ts
import { describe, expect, it } from "vitest";
import { MAX_RECONNECT_ATTEMPTS, reconnectDelayMs } from "./retry-policy.js";

describe("reconnect retry policy", () => {
  it("uses the approved capped exponential delays", () => {
    expect(MAX_RECONNECT_ATTEMPTS).toBe(5);
    expect([1, 2, 3, 4, 5].map(reconnectDelayMs)).toEqual([
      500, 1000, 2000, 4000, 8000,
    ]);
  });

  it("has no retry outside the bounded attempt range", () => {
    expect(reconnectDelayMs(0)).toBeUndefined();
    expect(reconnectDelayMs(6)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test:unit -- --run src/client/retry-policy.test.ts`

Expected: FAIL because `retry-policy.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure policy**

```ts
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
export const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

export function reconnectDelayMs(attempt: number): number | undefined {
  return RECONNECT_DELAYS_MS[attempt - 1];
}
```

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:unit -- --run src/client/retry-policy.test.ts`

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/retry-policy.ts src/client/retry-policy.test.ts
git commit -m "feat: define bounded reconnect policy"
```

### Task 2: Unexpected language-client stop seam

**Files:**
- Modify: `src/client/language-client.ts`
- Modify: `src/client/language-client.test.ts`

- [ ] **Step 1: Extend the language-client mock and write failing tests**

Capture `clientOptions.errorHandler`, expose a fake `onDidChangeState` event,
and add these behaviors:

```ts
it("disables the library's implicit restart", async () => {
  new FoundryScriptLanguageClient(options);
  const clientOptions = languageClientMock.constructorCalls[0]?.[3] as {
    errorHandler: { closed: () => PromiseLike<{ action: number; handled?: boolean }> };
  };
  expect(await clientOptions.errorHandler.closed()).toMatchObject({
    action: CloseAction.DoNotRestart,
    handled: true,
  });
});

it("reports only an unexpected running-to-stopped transition", () => {
  const client = new FoundryScriptLanguageClient(options);
  const stopped = vi.fn();
  const subscription = client.onUnexpectedStop(stopped);
  languageClientMock.fireState({ oldState: State.Starting, newState: State.Stopped });
  languageClientMock.fireState({ oldState: State.Running, newState: State.Stopped });
  expect(stopped).toHaveBeenCalledOnce();
  subscription.dispose();
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:unit -- --run src/client/language-client.test.ts`

Expected: FAIL because no error handler or `onUnexpectedStop` API exists.

- [ ] **Step 3: Implement the production seam**

Import `CloseAction`, `ErrorAction`, `State`, and `StateChangeEvent`. Add:

```ts
errorHandler: {
  error: () => ({ action: ErrorAction.Continue, handled: true }),
  closed: () => ({ action: CloseAction.DoNotRestart, handled: true }),
},
```

Expose:

```ts
onUnexpectedStop(listener: () => void): vscode.Disposable {
  return this.onDidChangeState(({ oldState, newState }: StateChangeEvent) => {
    if (oldState === State.Running && newState === State.Stopped) listener();
  });
}
```

- [ ] **Step 4: Verify GREEN and nearby behavior**

Run: `npm run test:unit -- --run src/client/language-client.test.ts src/client/transport.test.ts`

Expected: all language-client and real-socket transport tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/language-client.ts src/client/language-client.test.ts
git commit -m "feat: surface unexpected language server stops"
```

### Task 3: ConnectionManager reconnect state machine

**Files:**
- Modify: `src/client/connection-manager.ts`
- Modify: `src/client/connection-manager.test.ts`

- [ ] **Step 1: Add complete test doubles and failing state tests**

Extend client doubles with a real listener registry/disposable. Use
`vi.useFakeTimers()` and add:

```ts
it("publishes loss immediately and reconnects on the exact backoff", async () => {
  await manager.start(startOptions);
  firstClient.fireUnexpectedStop();
  expect(states.at(-1)).toMatchObject({
    kind: "retrying", attempt: 1, maxAttempts: 5, delayMs: 500,
  });
  await vi.advanceTimersByTimeAsync(499);
  expect(secondClient.start).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(secondClient.start).toHaveBeenCalledOnce();
  expect(states.at(-1)).toEqual({ kind: "connected" });
});

it("exhausts five attempts and leaves no hidden retry", async () => {
  firstClient.fireUnexpectedStop();
  await vi.advanceTimersByTimeAsync(15_500);
  expect(states.at(-1)).toEqual({ kind: "disconnected" });
  expect(createClient).toHaveBeenCalledTimes(6);
  await vi.runAllTimersAsync();
  expect(createClient).toHaveBeenCalledTimes(6);
});
```

Add separate tests for exact manual timer cancellation, success reset, fresh
client creation/open-document resync, attach ownership, spawn replacement, auto
fallback, stale completions, stop cancellation, and off making no attempt.

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:unit -- --run src/client/connection-manager.test.ts --testTimeout=2000`

Expected: FAIL on missing state, stop subscription, timers, and `reconnectNow`.

- [ ] **Step 3: Add lifecycle types and scheduler seam**

```ts
export type ConnectionState =
  | { readonly kind: "connected" }
  | { readonly kind: "spawning" }
  | { readonly kind: "retrying"; readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number }
  | { readonly kind: "disconnected" }
  | { readonly kind: "off" };

export interface DisposableHandle { dispose(): void; }
export interface RetryScheduler {
  schedule(delayMs: number, callback: () => void): DisposableHandle;
}
export interface LanguageClientHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  onUnexpectedStop(listener: () => void): DisposableHandle;
}
```

Add `scheduler`, `onStateChange`, and optional structured `output` fields to
`ConnectionManagerOptions`. The default scheduler uses `setTimeout` and returns
a clearable disposable.

- [ ] **Step 4: Implement generation-guarded retry**

Store original start options, immutable state, generation, retry timer, active
stop subscription, and stop flag. Centralize emission:

```ts
private publish(state: ConnectionState): void {
  this.currentState = state;
  this.options.onStateChange?.({ ...state });
}
```

On unexpected stop, increment generation and publish attempt 1 before cleanup.
Schedule through `reconnectDelayMs`. Every timer/start/cleanup completion checks
its captured generation. On the fifth failure, publish disconnected and log
exhaustion. `reconnectNow()` invalidates work, cancels its timer, publishes
attempt 1 with delay zero, cleans safely, and starts immediately. `stop()`
invalidates before disposing timers/subscriptions/startup/client/owned host.

- [ ] **Step 5: Verify GREEN and ownership regressions**

Run: `npm run test:unit -- --run src/client/connection-manager.test.ts src/client/host-launcher.test.ts --testTimeout=2000`

Expected: all manager and launcher tests pass under fake timers.

- [ ] **Step 6: Commit**

```bash
git add src/client/connection-manager.ts src/client/connection-manager.test.ts
git commit -m "feat: reconnect with bounded backoff"
```

### Task 4: Always-visible status controller

**Files:**
- Create: `src/client/connection-status.ts`
- Create: `src/client/connection-status.test.ts`

- [ ] **Step 1: Write failing rendering and action tests**

Use a complete status-item-shaped double and test every state plus both menus:

```ts
expect(renderConnectionState({ kind: "connected" }).text)
  .toBe("$(plug) FoundryScript: Connected");
expect(renderConnectionState({
  kind: "retrying", attempt: 3, maxAttempts: 5, delayMs: 2_000,
})).toMatchObject({ text: "$(sync~spin) FoundryScript: Retrying 3/5" });

await controller.showActions();
expect(showQuickPick).toHaveBeenCalledWith(
  ["Reconnect Now", "Open Log"], expect.any(Object),
);

controller.update({ kind: "off" });
await controller.showActions();
expect(showQuickPick).toHaveBeenLastCalledWith(
  ["Open Settings", "Open Log"], expect.any(Object),
);
```

- [ ] **Step 2: Run and verify RED**

Run: `npm run test:unit -- --run src/client/connection-status.test.ts`

Expected: FAIL because the controller module does not exist.

- [ ] **Step 3: Implement rendering and action dispatch**

Export `CONNECTION_ACTIONS_COMMAND`, action labels, pure
`renderConnectionState`, and:

```ts
update(state: ConnectionState): void {
  this.state = state;
  const presentation = renderConnectionState(state);
  this.item.text = presentation.text;
  this.item.tooltip = presentation.tooltip;
}

async showActions(): Promise<void> {
  const choices = this.state.kind === "off"
    ? [OPEN_SETTINGS_ACTION, OPEN_LOG_ACTION]
    : [RECONNECT_ACTION, OPEN_LOG_ACTION];
  const choice = await this.actions.showQuickPick(choices);
  if (choice === RECONNECT_ACTION) await this.actions.reconnectNow();
  if (choice === OPEN_LOG_ACTION) this.actions.openLog();
  if (choice === OPEN_SETTINGS_ACTION) await this.actions.openSettings();
}
```

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:unit -- --run src/client/connection-status.test.ts`

Expected: all rendering/action tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/client/connection-status.ts src/client/connection-status.test.ts
git commit -m "feat: add language server connection status"
```

### Task 5: Runtime and extension integration

**Files:**
- Modify: `src/client/runtime.ts`
- Modify: `src/client/runtime.test.ts`
- Modify: `src/extension.ts`
- Modify: `src/extension.test.ts`

- [ ] **Step 1: Write failing runtime composition tests**

```ts
createConnectionManager(outputChannel, workspacePath, onStateChange);
expect(runtimeMock.managerOptions[0]?.onStateChange).toBe(onStateChange);
const client = runtimeMock.managerOptions[0]?.createClient(endpoint, signal);
expect(clientOptions.signal).toBe(signal);
expect(clientOptions.workspaceMismatchHandler).toBeDefined();
expect(client).toBeDefined();
```

Also assert the manager receives `outputChannel` for structured retry logs.

- [ ] **Step 2: Write failing extension integration tests**

Extend the VS Code mock with `createStatusBarItem`, `registerCommand`,
`showQuickPick`, `StatusBarAlignment.Left`, output `show`, and manager
`reconnectNow`. Add:

```ts
it("shows truthful off status without a connection attempt", async () => {
  configuration.set("lsp.mode", "off");
  await activate(context);
  expect(statusItem.show).toHaveBeenCalledOnce();
  expect(statusItem.text).toContain("Off");
  expect(createConnectionManager).not.toHaveBeenCalled();
});

it("runs immediate reconnect and opens the log from the status command", async () => {
  await activate(contextWithWorkspace);
  await registeredCommands.get(CONNECTION_ACTIONS_COMMAND)?.();
  expect(reconnectNow).toHaveBeenCalledOnce();
});
```

Also prove off offers settings/log, state callbacks render, initial failure ends
disconnected, and deactivation disposes/stops once.

- [ ] **Step 3: Run and verify RED**

Run: `npm run test:unit -- --run src/client/runtime.test.ts src/extension.test.ts`

Expected: FAIL because status creation, command wiring, state callbacks, and
manual reconnect are absent.

- [ ] **Step 4: Implement runtime composition**

```ts
export function createConnectionManager(
  outputChannel: vscode.OutputChannel,
  workspacePath: string,
  onStateChange: (state: ConnectionState) => void,
): ConnectionManager
```

Pass `onStateChange` and `output: outputChannel` to `ConnectionManager` while
preserving launcher logging, abort signal, and workspace mismatch handling.

- [ ] **Step 5: Implement extension status/action lifecycle**

Create/show the item before the off branch:

```ts
const statusItem = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Left, 100,
);
statusItem.command = CONNECTION_ACTIONS_COMMAND;
statusItem.show();
```

Create the controller with closures for the current manager, output `show`, and
settings command. Register `controller.showActions`. Initialize off or
disconnected, create the manager only for non-off mode, and pass
`controller.update` as state callback. Preserve actionable initial errors and
publish disconnected before showing them.

- [ ] **Step 6: Verify GREEN and full unit integration**

Run: `npm run test:unit -- --run src/client/runtime.test.ts src/extension.test.ts src/client/connection-status.test.ts src/client/connection-manager.test.ts`

Expected: all focused tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/client/runtime.ts src/client/runtime.test.ts src/extension.ts src/extension.test.ts
git commit -m "feat: wire reconnect status and actions"
```

### Task 6: Documentation, review, and publication

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update user documentation**

```md
If a running language server disappears, the extension reports the loss in its
status-bar item and retries five times with capped exponential backoff. Click
the item to reconnect immediately or open the LSP log. After retries are
exhausted it rests in Disconnected until you reconnect manually. Off mode stays
visible but never starts or connects to Foundry.
```

- [ ] **Step 2: Run fresh focused verification**

Run:

```bash
npm run test:unit -- --run src/client/retry-policy.test.ts src/client/language-client.test.ts src/client/connection-manager.test.ts src/client/connection-status.test.ts src/client/runtime.test.ts src/extension.test.ts
```

Expected: every issue #9-focused test passes.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
git diff --check origin/main...HEAD
npm run package -- --out /tmp/foundryscript-issue-9.vsix
```

Expected: all unit/grammar tests, typecheck, lint, build, diff check, and VSIX
packaging pass.

- [ ] **Step 4: Commit documentation**

```bash
git add README.md docs/superpowers/plans/2026-07-31-reconnect-status.md
git commit -m "docs: explain reconnect status behavior"
```

- [ ] **Step 5: Run the required independent review workflow**

Run Cursor Agent in read-only plan mode against `origin/main` exactly as
specified by `/Users/christian/.agents/skills/cursor-review/SKILL.md`. Triage
every valid finding with receiving-code-review and systematic-debugging, add a
failing regression test before each production fix, verify, commit, and repeat
until the latest valid result is exactly `RESULT: clean` with `- none` findings.

- [ ] **Step 6: Recheck base and publication gates**

Fetch `origin/main`. If it advanced, integrate it, rerun all verification, and
repeat Cursor on the final HEAD before enabling auto-merge. Then push, open a
PR against main whose body ends `Closes #9`, enable squash auto-merge only after
the clean review, monitor all CI through actual merge, and remove only the
issue-9 worktree and local/remote issue-9 branches after landing.
