# Canonical Combined Tooling Host Design

## Goal

Migrate extension-owned Foundry startup from the deprecated `foundry lsp serve`
compatibility command to the canonical combined `foundry tooling serve` host, while
leaving externally owned attach and auto-attach behavior unchanged.

Publishing a Foundry-Scripting release is explicitly outside this implementation's
scope. The completed change will be ready for maintainers to include in a later release.

## Root Cause

`FoundryHostLauncher` still implements the legacy single-service startup model. It
allocates and releases a loopback port, passes that guessed port to `lsp serve`, and can
declare the child ready after a TCP probe succeeds. The engine's canonical tooling host
instead owns LSP and DAP listeners atomically, selects both ephemeral ports itself, and
reports the bound ports through a `FOUNDRY_TOOLING` readiness record.

The existing parser recognizes part of the combined record, but it permits an absent
DAP service or port, does not require a positive PID or distinct ports, and does not
validate the record's project against the requested canonical project. The output
observer only classifies structured errors on stderr and reduces them to a bind-failure
boolean, so it cannot preserve invalid-project or unknown structured failures.

## Command and Ownership Model

The existing `FoundryHostLauncher` remains the single owner of extension-spawned
processes. It will construct this exact argument vector without allocating a port:

```text
tooling
serve
--project
<project>
--lsp-port
0
--dap-port
0
```

Legacy-specific types and function names will be replaced with tooling-host names. The
launcher will supervise one child process and return one `OwnedToolingHost`. Its
readiness object will retain both `lspPort` and `dapPort`; the connection manager will
continue to connect the language client only to `lspPort`.

The configured `foundryScript.lsp.port` remains relevant only to attach mode and the
first attach attempt in auto mode. Spawn mode and the spawn fallback from auto mode will
not read it, reserve it, or probe it.

## Readiness Contract

Spawned startup will succeed only after a complete newline-delimited
`FOUNDRY_TOOLING` record is read from the child. Chunk boundaries may split the marker
or JSON, so the existing per-stream buffering model remains in place.

The launcher will accept a readiness record only when all of these conditions hold:

- `project` exactly matches the canonical project passed to the launcher;
- `pid` is a positive integer;
- `local_only` is `true`;
- `services` is a string array containing both `lsp` and `dap`;
- `lsp_port` and `dap_port` are integers from 1 through 65535; and
- the two reported ports are distinct.

Malformed JSON, the wrong marker, a mismatched project, incomplete service data, or any
invalid field is not readiness. No TCP connection probe can substitute for the record.
Ordinary startup output remains activity for inactivity timeout purposes and continues
to be logged through the existing structured output channel.

## Failure Model

Both stdout and stderr will be inspected for newline-delimited
`FOUNDRY_TOOLING_ERROR` records. Stdout is canonical; stderr is accepted for compatibility
with older and development engine builds. A well-formed record includes an error code
and may include an engine-provided message.

Structured failures map as follows:

- `bind_failed` becomes `port_conflict`;
- `invalid_project` becomes a new `invalid_project` startup failure; and
- any other well-formed error becomes `spawn_failed` while preserving its message.

The structured record will be stored as terminal startup state. It takes precedence
over a subsequent child exit, timeout, or human-readable stderr classification. When no
structured failure exists, existing missing-engine, spawn-error, process-exit, and
timeout classifications remain available. Messages and logs will describe the project
without inventing a caller-selected spawn port.

Every unsuccessful startup after child creation will use one idempotent cleanup path:
stop the owned child and flush buffered startup output once. Cancellation, inactivity or
absolute timeout, malformed/incomplete readiness followed by timeout, terminal tooling
error, spawn error, and early exit all follow that path. A synchronously rejected spawn
has no child to stop.

## Code Boundaries

Changes stay within the existing client lifecycle boundary:

- `src/client/host-launcher.ts` constructs the command, parses protocol records,
  validates readiness, classifies startup failures, and owns child cleanup;
- `src/client/host-launcher.test.ts` proves command, parsing, failure precedence,
  buffering, and cleanup behavior;
- `src/client/connection-manager.test.ts` proves spawn uses the reported LSP port while
  attach and auto-attach continue using the configured port;
- `README.md` and active agent guidance describe `tooling serve` and the two ephemeral
  ports.

No DAP session, debug configuration, new setting, engine protocol change, or attach-host
lifecycle change is included.

## Testing Strategy

Implementation will follow test-driven development. Focused failing tests will first
cover:

1. the exact canonical command vector and absence of port allocation;
2. complete and split readiness records retaining distinct LSP and DAP ports;
3. rejection of each invalid combined-record shape and of TCP-only readiness;
4. structured bind, invalid-project, and unknown errors on stdout and stderr;
5. structured failure precedence over a subsequent exit;
6. exactly-once termination and buffered-output flushing for unsuccessful owned starts;
7. language-client use of the reported LSP port; and
8. unchanged attach and auto-attach configured-port behavior.

After focused red/green cycles, completion requires the repository gates from
`AGENTS.md`: `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`, and
`npm test`.
