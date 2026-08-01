# LSP Cold-Start Readiness Design

## Goal

Allow the extension-owned Foundry language server to finish legitimate cold-project
initialization without waiting indefinitely for a stalled or noisy process, and make
startup activity visible in the FoundryScript LSP output channel.

## Problem

The host launcher currently gives every spawned Foundry process a fixed ten seconds to
publish a tooling-readiness record or open its requested TCP port. A project without an
import cache can spend longer than ten seconds scanning files, registering script
classes, and initializing editor state. The extension then terminates a healthy process
and reports only a generic readiness timeout.

The launcher already consumes stdout to recognize `FOUNDRY_TOOLING` readiness records
and stderr to classify bind failures, but it does not expose ordinary startup output in
the LSP log. Users therefore cannot distinguish active initialization from a stalled
host.

## Startup Timing Model

Replace the single fixed deadline with two independent limits:

- An inactivity limit of 15 seconds. Any bytes received from Foundry on stdout or stderr
  reset this deadline. Opening the requested TCP port or publishing a valid
  `FOUNDRY_TOOLING` record still completes readiness immediately.
- An absolute limit of two minutes from process spawn. Output activity never extends
  this limit.

The first expired limit determines the failure. An inactive process reports that no
startup activity was observed for 15 seconds. A continuously active process that never
becomes ready reports that startup exceeded two minutes. Both failures terminate the
extension-owned process through the existing shutdown path.

The timing values remain constructor options for deterministic unit tests. They are not
added as user-facing settings: the limits are extension lifecycle policy, and exposing
them would add configuration without resolving a normal user need.

## Output Observation and Logging

The host launcher remains the only component that knows about Foundry process streams.
Its stream observer will have three responsibilities:

1. Record activity immediately when either stream emits bytes, including chunks that do
   not contain a complete line.
2. Preserve the existing readiness-record and bind-failure parsing.
3. Forward complete, non-empty startup lines to the structured FoundryScript LSP output
   channel. Each record identifies the source stream as `stdout` or `stderr` and keeps
   the Foundry text as an opaque message field.

The launcher will log a structured timeout event with the project, port, timeout kind,
and relevant duration before it stops the child. It will not log raw chunks or parse
ordinary human-readable output beyond the existing bind-failure classification. This
keeps records readable while preventing transport chunk boundaries from affecting log
semantics.

A final unterminated line is retained for parsing while the process is alive. If startup
fails or the process exits, any non-empty buffered tail is logged once before the
failure is reported. Readiness records may also appear in startup logs; readiness
parsing remains authoritative and logging does not alter control flow.

## Failure Model

`HostStartupFailure` retains the existing `readiness_timeout` kind so connection-manager
behavior and user actions do not change. It gains timeout-reason context sufficient to
produce distinct inactivity and absolute-limit messages. Existing missing-engine,
spawn, process-exit, port-conflict, cancellation, and cleanup behavior remains
unchanged.

Port conflicts continue to take precedence when bind-failure evidence exists at the
time either timeout expires. A process exit continues to be classified immediately
rather than waiting for either deadline.

## Testing

Focused Vitest coverage in `src/client/host-launcher.test.ts` will use fake child streams
and short injected limits to prove:

- silence triggers the inactivity timeout and its specific message;
- stdout and stderr activity each extend the inactivity window;
- incomplete chunks count as activity;
- continuous activity cannot extend startup beyond the absolute limit;
- readiness from either the structured record or requested TCP port still succeeds;
- complete startup lines and final buffered tails are logged once with their stream;
- bind conflicts, early process exit, and cancellation retain their current precedence
  and cleanup behavior.

The repository verification remains `npm ci`, `npm run build`, `npm run typecheck`,
`npm run lint`, and `npm test`.

## Scope

This change is confined to the LSP host-launcher implementation, its colocated tests,
and user-facing documentation explaining cold-start behavior. It does not change the
Foundry engine protocol, connection modes, retry policy, task processes, test adapter,
or diagnostics arbitration.
