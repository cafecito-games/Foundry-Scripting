# Reconnect With Backoff and Visible Status

## Goal

Keep FoundryScript language intelligence visibly healthy when its TCP language
server disappears. The extension reconnects a bounded number of times, reports
every lifecycle state in the status bar, lets the user retry immediately, and
never silently retries forever.

## Connection lifecycle

`ConnectionManager` remains the sole owner of the active language client, an
optional spawned tooling host, pending startup, retry timer, and remembered
connection settings/project. Its public state is one of:

- `connected`
- `spawning`
- `retrying`, including the current attempt, the maximum attempt count, and the
  delay before that attempt
- `disconnected`
- `off`

State snapshots are immutable and emitted before asynchronous cleanup whenever
the server is lost, ensuring the visible state changes within one second.

`FoundryScriptLanguageClient` disables `vscode-languageclient`'s implicit
restart by supplying a handled error handler whose close action is
`DoNotRestart`. It exposes an unexpected-stop signal only for a public
`Running -> Stopped` transition. A fresh language client is created and started
for every reconnect attempt. The library's normal initialization then registers
text synchronization and sends `didOpen` for matching documents already open in
the workspace, refreshing diagnostics without a VS Code window reload.

On an unexpected stop, the manager synchronously publishes retrying attempt 1,
invalidates stale callbacks, cleans the dead client and only an extension-owned
host, then schedules attempts after 500 ms, 1 s, 2 s, 4 s, and 8 s. These are
five total reconnect attempts with an 8-second cap. Each attempt repeats the
configured mode:

- `attach` reconnects to the configured external port and never kills the
  external host.
- `spawn` stops any previously owned host and launches a replacement.
- `auto` tries the configured external port and falls back to spawn only on
  `ECONNREFUSED`, preserving the connection-mode contract from issue #8.
- `off` makes no client, socket, or process attempt.

A successful connection publishes connected and resets the retry sequence. A
fifth failure publishes disconnected, writes an exhaustion log record, and
leaves no timer. `reconnectNow()` cancels a pending timer, invalidates stale
async completions, resets the retry sequence, cleans resources as necessary,
and begins an attempt immediately. `stop()` first disables callbacks and timers,
then cleans the client and only an owned host.

Generation tokens guard every asynchronous completion. Work from a cancelled
retry, manual reconnect, or extension shutdown cannot overwrite newer state or
install stale resources.

## Status and commands

A dedicated status controller owns one left-aligned status-bar item. It is
created, shown, and initialized during activation even when the configured mode
is off. Rendering is centralized:

| State | Visible text | Detail |
| --- | --- | --- |
| Connected | `FoundryScript: Connected` | Language server is ready |
| Spawning | `FoundryScript: Spawning` | Extension-owned host is starting |
| Retrying | `FoundryScript: Retrying N/5` | Tooltip includes the next delay |
| Disconnected | `FoundryScript: Disconnected` | Retry limit reached or startup failed |
| Off | `FoundryScript: Off` | Connections are disabled by configuration |

Clicking the item runs `foundryScript.connectionActions` and opens a quick-pick
menu. Connected, spawning, retrying, and disconnected states offer `Reconnect
Now` and `Open Log`. Off offers `Open Settings` and `Open Log`; it never
implicitly overrides the user's off setting. Reconnect Now cancels a timer and
starts immediately. Open Log reveals the existing FoundryScript LSP output
channel. Open Settings targets `foundryScript.lsp.mode`.

Initial configuration and startup failures keep issue #8's actionable error
messages and finish in disconnected. Mid-session failures update status and
write structured log records without repeated popups. Exhaustion is a clear,
non-alarming resting state.

The status controller, command registration, connection manager, and output
channel are all disposed with the extension. Off mode retains the status
controller while making zero socket/process attempts.

## Components

- `src/client/retry-policy.ts` owns the pure fixed policy and validates attempt
  lookup without VS Code or timers.
- `src/client/connection-manager.ts` owns lifecycle state, timers, generation
  guards, clients, and spawned hosts.
- `src/client/language-client.ts` translates real language-client state changes
  into the unexpected-stop seam and disables built-in restarts.
- `src/client/connection-status.ts` maps immutable state snapshots to status-bar
  presentation and owns the command action menu.
- `src/client/runtime.ts` composes real clients, hosts, timers, logging, status,
  and workspace mismatch handling.
- `src/extension.ts` creates the always-visible status UI, registers its command,
  activates the configured lifecycle, and disposes everything.

## Testing

Tests use deterministic fake timers and complete client/host doubles through
the production lifecycle interfaces.

- Pure retry-policy tests prove the five delays and bounded exhaustion.
- Connection-manager tests prove immediate loss visibility, exact retry counts
  and timing, success reset, exhaustion without a timer, immediate manual
  reconnect, stale-completion guards, owned-host replacement, external-host
  preservation, off behavior, and shutdown cancellation.
- Language-client tests prove implicit restart is disabled and only unexpected
  `Running -> Stopped` transitions notify the manager.
- A reconnect test proves a fresh client is constructed and started, which
  triggers the language client's standard open-document synchronization during
  initialization.
- Status-controller tests cover every rendered state and both quick-pick action
  sets without asserting on mock-only UI elements.
- Extension/runtime tests prove the status item is shown in off mode with no
  manager attempt, commands are wired to immediate reconnect/log/settings, and
  all resources are disposed.
- Existing real-socket transport tests remain the proportionate integration
  boundary for refusal and close behavior.

## Out of scope

- Infinite or configurable retry policies
- Background reconnect while mode is off
- Changes to Foundry's LSP or combined tooling-host protocol
- Status-bar configuration or additional notifications
- Reconnect behavior for future DAP support
