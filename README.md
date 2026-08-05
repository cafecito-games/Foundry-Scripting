# FoundryScript for Visual Studio Code

Language support for [FoundryScript](https://github.com/cafecito-games/Foundry) (`.fs`),
the gradually-typed scripting language of the Foundry engine.

## Requirements

FoundryScript requires Visual Studio Code 1.125.0 or newer. Engine requirements for
debugging and selected-test support are documented under
[Engine compatibility](#engine-compatibility).

## Features

- Semantic highlighting from the Foundry language server, including contextual keywords,
  declarations, symbol kinds, and modifiers such as `final`, with the full TextMate
  grammar retained as an offline fallback.
- Comment toggling, bracket matching, off-side folding, and indentation for
  FoundryScript's indentation-sensitive block structure.
- Language intelligence over the Foundry engine's language-server protocol, including
  completion, hover, go-to-definition, and diagnostics.
- Scene debugging through VS Code's Run and Debug view, including line breakpoints,
  stack frames, variables, Watch expressions, Debug Console evaluation, stepping,
  pause, continue, restart, and stop.
- Test Explorer debugging for an individual test, a suite, or the complete discovered
  test tree, with selection, exclusion, cancellation, and restart support.

By default the extension starts Foundry's canonical combined tooling host for the open
workspace:

```sh
foundry tooling serve --project <dir> --lsp-port 0 --dap-port 0
```

Foundry binds two ephemeral loopback ports and reports them in its `FOUNDRY_TOOLING`
readiness record. The extension connects language features to the reported LSP port and
scene debugging to the reported DAP port. The `foundry` executable must be on `PATH`
or configured with `foundryScript.enginePath`.

Set `foundryScript.lsp.mode` to `attach` to connect to an already-running editor/tool
host, `auto` to attach first and spawn only when the configured port refuses the
connection, or `off` to keep syntax highlighting without starting or connecting to
Foundry. Attach and auto's initial attach use `foundryScript.lsp.port` (default `6005`);
debugging in an externally owned host uses `foundryScript.dap.port` (default `6006`).
Spawned hosts use the ephemeral ports from their readiness record instead of either
configured port. Hosts spawned by the extension are stopped with it; externally started
hosts are never terminated by the extension.

### Selecting the Foundry project

The extension first checks `foundryScript.projectPath`. Relative values are resolved
from the first workspace folder. Without that setting, a workspace-root
`project.foundry` wins; otherwise, the extension automatically selects exactly one
nested `project.foundry`.

Wrapper repositories can select their project explicitly:

```json
{
  "foundryScript.projectPath": "test_project"
}
```

If multiple nested projects exist, configure `foundryScript.projectPath`. The extension
currently operates one Foundry project per VS Code window.

**Multi-root workspaces:** only the first file-scheme workspace folder participates in
project resolution. This is intentional — reorder folders to switch which project is
active, or set `foundryScript.projectPath` to target a project in a non-first folder.

Cold project initialization may include file scanning, script-class registration, and
editor setup before the tooling readiness record appears. While Foundry emits startup
output, the extension allows that work to continue for up to two minutes. A silent
startup is treated as stalled after 15 seconds. Startup output and the specific timeout
reason are available from the `FoundryScript LSP` output channel.

If a running language server disappears, the extension reports the loss in its
status-bar item and retries five times with capped exponential backoff. Click the item
to reconnect immediately or open the LSP log. After retries are exhausted it rests in
Disconnected until you reconnect manually. Off mode stays visible but never starts or
connects to Foundry; click it to open connection settings or the log.

## Engine compatibility

Scene and selected-test debugging require **Foundry `v0.1.0-alpha.24` or later**.
`v0.1.0-alpha.24` is the first verified compatible release; its tag resolves to engine
commit `e91ab07e63ce0a783778dc885bb11d9c65603256`. It contains the required
scene-debugger work, the structured selected-test launch contract, and the natural-exit
lifecycle fix from
[Foundry #1634](https://github.com/cafecito-games/Foundry/issues/1634). Earlier
prereleases, including `v0.1.0-alpha.21` through `v0.1.0-alpha.23`, are not declared
debugger-compatible.

Point the extension at the compatible editor binary:

```json
{
  "foundryScript.enginePath": "/absolute/path/to/foundry"
}
```

The published `v0.1.0-alpha.24` macOS universal binary reports
`0.1.alpha24.gh.e91ab07e6` and passes the complete scene and no-main-scene selected-test
DAP conformance matrix on macOS 26.5.2 (Apple silicon). CI downloads the published Linux
asset, verifies its GitHub-provided SHA-256 digest, verifies the same engine identity,
and runs the unchanged required lifecycle suite. The prior hands-on Extension
Development Host matrix and the exact VS Code build are tracked alongside the
alpha.24 artifact evidence in
[`tests/manual/debugger-release-2026-08-03.md`](tests/manual/debugger-release-2026-08-03.md).

## Scene debugging

Open a Foundry project, switch to **Run and Debug**, and press **F5**. When no debug
configuration is present, the extension supplies a default launch of the project's main
scene. To keep or customize it, create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "foundryscript",
      "request": "launch",
      "name": "Debug Main Scene",
      "scene": "main",
      "args": ["--profile", "developer"]
    },
    {
      "type": "foundryscript",
      "request": "launch",
      "name": "Debug Explicit Scene",
      "scene": "res://levels/forest.tscn",
      "args": []
    }
  ]
}
```

`scene` must be `main` or a canonical `res://` path ending in `.tscn`. `args`
must contain only strings. FoundryScript supports DAP launch requests; a DAP
`request: "attach"` configuration is not supported. The connection setting named
`attach` means “use an externally owned combined tooling host,” not a DAP attach
request.

Use **Run Without Debugging** (`Ctrl+F5`) to launch the same scene and arguments with
breakpoints disabled. Restricted Mode behavior is provided by VS Code's normal workspace
trust prompt before debugging or extension-host development can execute project code.

### Connection modes and lifecycle

| `foundryScript.lsp.mode` | Debugger behavior |
| --- | --- |
| `spawn` | Starts one combined tooling host and uses its reported ephemeral DAP port. |
| `attach` | Uses the external host at `foundryScript.lsp.port` and `foundryScript.dap.port`. |
| `auto` | Tries the configured external host first, then starts an owned host if the LSP port refuses the connection. |
| `off` | Keeps offline language support but rejects debug startup with an actionable error. |

All tooling connections are loopback-only. One FoundryScript debug session—scene or
selected-test—may be active per VS Code window. Stop and in-session restart affect the
debuggee, not the combined tooling host, so language features stay connected. Extension
deactivation stops active debugging and an extension-owned host. The extension never
terminates an external host. A normal Stop or natural exit does not report the expected
late transport close as an adapter failure.

### Supported debugger features

- Source line breakpoints in `.fs` files.
- Pause, continue, step over, step into, step out, restart, and stop.
- Call stacks and Locals, Members, and Globals scopes.
- Watch expressions, hover evaluation, and Debug Console evaluation.
- Main-scene and explicit-scene launches, play arguments, and Run Without Debugging.

The current adapter does not support conditional breakpoints, hit counts, logpoints,
editing variable values, remote-device debugging, or concurrent sessions. Values that
the engine cannot expand are shown as scalar representations.

### Debugging selected tests

Enable Test Explorer integration and configure the canonical runner resource for your
project:

```json
{
  "foundryScript.testing.enabled": true,
  "foundryScript.testing.runner": "res://tests/test_runner.fs",
  "foundryScript.testing.args": []
}
```

Open VS Code's **Testing** view, select the **Debug** run profile, then use the debug
action on the Foundry controller, a suite, or an individual test. Controller and suite
selections expand to their runnable descendant tests; explicitly excluded tests and
suites are removed from that selection. The engine receives only the resulting test
IDs. Selected-test debugging uses an internal structured launch, so the project does not
need to define a main scene.

Cancelling the Test Run or stopping its debug session terminates the DAP-owned test
process. Results already reported remain visible and uncompleted selected tests are
marked skipped. **Restart** reruns the same selection, resets the temporary test report,
and does not duplicate results already published to Test Explorer. The global
one-session rule also applies here: stop any active scene or test debug session before
starting another. Test debugging requires Foundry `v0.1.0-alpha.24` or later.

#### Test runner settings

The extension exposes two similarly named runner settings because the
**Foundry: Test** task and the **Test Explorer** adapter are separate features:

| Setting | Used by | Purpose |
|---------|---------|---------|
| `foundryScript.test.runner` | The **Foundry: Test** task (`foundry project test`) | Runner passed on the command line for the human-facing task. |
| `foundryScript.testing.runner` | The **Test Explorer** adapter | Canonical `res://` resource implementing the Foundry Test Adapter Protocol used by Run/Debug in the Testing view. |

Configure both if you use both features; each is validated independently and only the
setting relevant to a given flow is reported on failure.

### Troubleshooting

Open **Output: FoundryScript Debug** for the resolved project, connection mode, DAP
endpoint, scene, `noDebug` state, and play-argument count. Tooling startup and language
connection details remain in **Output: FoundryScript LSP**.

Common startup errors name the corrective setting:

- An unavailable external endpoint: start `foundry tooling serve` for the same project
  and verify `foundryScript.dap.port`.
- An invalid scene or argument list: use `main` or a canonical `res://.../*.tscn`
  path and an array of strings.
- A second session: stop the active FoundryScript session, then retry.
- Off mode: change `foundryScript.lsp.mode` to `spawn`, `attach`, or `auto`.

## Installation

Download the `.vsix` from a release or a CI build artifact, then:

```
code --install-extension foundryscript-<version>.vsix
```

## Known conflict: `.fs` and F#

`.fs` is also F#'s conventional extension. If you have an F# extension such as Ionide
installed, VS Code may pick the wrong language for your files. Force the association per
workspace in `.vscode/settings.json`:

```json
{
  "files.associations": {
    "*.fs": "foundryscript"
  }
}
```

## Semantic highlighting and fallback

When connected to a compatible Foundry language server, the extension uses the
server-advertised semantic-token legend and full-document token responses. This lets
the parser distinguish contextual words such as `extend`, `async`, `annotation`,
`targets`, `get`, and `set` from identifiers with the same spelling, and distinguishes
declarations, symbol kinds, and modifiers such as `static`, `final`, and `readonly`.

The TextMate grammar remains active underneath semantic highlighting. It provides
highlighting while LSP mode is `off`, while the server is unavailable, and when an older
or incompatible server does not advertise the expected full semantic-token capability.
Capability and response problems are recorded in the FoundryScript LSP output log; they
do not disable completion, hover, diagnostics, or other language-server features.

### TextMate-only limitations

A TextMate grammar matches patterns line by line with no knowledge of the parser's
context, so a specific and bounded set of cases highlight incorrectly. Listed roughly in
descending user impact:

1. **Keywords used as identifiers, attribute names, or node names.** `GRAMMAR.md` §2.5
   permits `match`, `when`, `uses` and `PI`/`TAU`/`INF`/`NAN` as ordinary identifiers,
   accepts a broad set of keywords as attribute names after `.`, and accepts them as node
   names in a get-node path. So `var match = 1` and `obj.class` paint a keyword where the
   language has an identifier. This is the largest class.
2. **`%` immediately followed by an identifier with a space before it.** `x %y`
   highlights as a unique-name node path rather than modulo. `x%y`, `arr[0]%n` and
   `f(1)%n` are handled correctly; only the space-before-no-space-after form is
   ambiguous, and distinguishing it needs variable-length lookbehind that Oniguruma does
   not support.
3. **Built-in types are matched by name.** A user-defined class or local variable named
   `Color`, `Type`, or `int` is painted as a built-in. The alternative — inferring types
   from `identifier: Type` position — cannot be told apart from dictionary literals or
   match arms and misfires far more often.
4. **Property accessors.** `get`/`set` are recognised at the start of a line. A
   multiline dictionary entry or named call argument (`get = 1` on its own line inside
   brackets) false-positives, and the single-line inline property form
   (`var x: int = 1: get = a, set = b`) is missed.
5. **Unterminated strings.** A short string with no closing quote is bounded to its own
   line rather than running to end of file. One exception: a string ending in an escaped
   backslash (`"a\\`) leaks exactly one line.
6. **Invalid numeric literals** mis-scope rather than erroring — `1.5abc` highlights
   `1.5` and leaves `abc` plain.
7. **Generic type parameters are unscoped** — `class_name Box[T]` highlights `Box` but
   not `[T]`.
8. **`@` has no left boundary** — `a@b` highlights `@b` as an annotation.

These cases are inherent to regex-based, line-oriented TextMate grammars and can still
appear when semantic highlighting is unavailable. The committed fallback is the
unmodified [engine-published grammar](syntaxes/foundryscript.tmLanguage.json), and its
behavior is covered by the scope assertions under `tests/grammar/`.

## Development

```
npm ci
npm run build
npm test
```

### Updating the engine grammar

The committed TextMate grammar is the complete release artifact for the engine version
pinned in [`foundry-grammar.json`](foundry-grammar.json). That manifest is the only place
to change the version.

To update it:

1. Change `engineVersion` in `foundry-grammar.json`.
2. Run `npm run sync-grammar`.
3. Review the grammar and scope-assertion diffs.
4. Run `npm run test:grammar` and, when an engine checkout is available,
   `FOUNDRY_ENGINE_PATH=/path/to/Foundry npm run test:corpus`.

`npm run check:grammar-sync` downloads the pinned release asset, validates its
SHA-256 against the digest pinned in `foundry-grammar.json`, structurally checks
the JSON against the grammar contract, and finally compares the downloaded bytes
to the committed grammar. CI runs this as an explicit online drift and integrity
check. Synchronization is not part of installation, building, packaging, or
extension startup; after `npm ci`, normal builds use only files already in the
checkout.

To run the corpus regression check against an engine checkout:

```
FOUNDRY_ENGINE_PATH=/path/to/Foundry npm run test:corpus
```

This tokenizes roughly 1,326 valid `.fs` files from the engine checkout and fails on any
unexpected `invalid.illegal` scope. Local runs without `FOUNDRY_ENGINE_PATH` skip
cleanly with an explanatory message.

CI does not skip this check. Its `corpus` job checks out an immutable Foundry commit for
the same release pinned in `foundry-grammar.json`, sets `FOUNDRY_ENGINE_PATH`, and fails
if the checkout yields zero `.fs` files. When updating the grammar release, update the
corpus checkout SHA in `.github/workflows/ci.yml` to the commit behind that release.

Press F5 in VS Code to launch an Extension Development Host.

### Testing

Negative scope assertions (`- some.scope`) must name the **fully-qualified** scope
(`- constant.numeric.integer.foundryscript`, never `- constant.numeric`) — the test
runner does an exact string match, so an unqualified scope can never fail regardless of
whether the bug it guards against is present. The `#` that starts an assertion line must
be in column 1; an indented `#` is parsed as ordinary source, not an assertion. Every
negative assertion must be proven to fail by deliberately breaking the grammar before
it is trusted — an assertion nobody has seen fail is not evidence of anything.
`npm run test:grammar` includes a scan that catches assertions whose carets select no
tokens.
