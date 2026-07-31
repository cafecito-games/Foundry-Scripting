# Lint JSON Diagnostics Design

## Goal

Populate VS Code's Problems panel from `foundry script lint --format=json`
without problem-matcher regular expressions, while preserving ordinary task output,
task cancellation, and language-server diagnostic precedence.

## Inputs and constraints

The Foundry JSON report is versioned and has this shape:

```json
{
  "version": 1,
  "diagnostics": [
    {
      "path": "res://scripts/player.fs",
      "range": {
        "startLine": 4,
        "startColumn": 2,
        "endLine": 4,
        "endColumn": 18
      },
      "severity": "warning",
      "source": "foundry_script",
      "ruleId": "UNUSED_VARIABLE",
      "message": "The variable is never used."
    }
  ]
}
```

Lines and columns are one-based, and end positions are exclusive. Severities are
`error`, `warning`, or `note`. Lint exits with code 0 when no configured failure
threshold is reached, 1 for reported errors, and 2 for command failures. A report
from exit 0 or 1 is complete and publishable; exit 2 and cancellation are not.

The implementation must use JSON directly. It must not add a problem matcher,
SARIF support, Test Explorer behavior, or a live Foundry dependency to tests.

## Architecture

### Report parser

`src/tasks/lint-report.ts` owns strict validation and conversion of version 1 JSON.
It accepts the captured stdout text and workspace project path and returns domain
diagnostics with absolute file paths and zero-based ranges. `res://` paths resolve
under the project; absolute paths remain absolute; relative paths resolve from the
project. The parser rejects malformed JSON, unsupported versions, incomplete fields,
invalid ranges, and unknown severities as a whole rather than publishing a partial
or misleading result.

The parser maps `error`, `warning`, and `note` without losing the original source or
rule id. The VS Code adapter sets `Diagnostic.source` and `Diagnostic.code`, which
makes the rule id visible in Problems.

### Stateful CLI publisher

`src/tasks/lint-diagnostics.ts` converts parsed domain diagnostics to VS Code
diagnostics, groups them by file URI, and submits each group to the diagnostics unit
with `source: "cli"`. It remembers the set of URIs from the last applied report.
On each later applied report, it sends an empty CLI batch for every previously seen
URI absent from the new report, then replaces its remembered set. This makes a clean
rerun remove fixed diagnostics.

Only reports from numeric lint exits 0 or 1 are applied. Cancellation, exit 2,
spawn failure, or malformed JSON preserve both the visible diagnostics and the
publisher's remembered URI set. If multiple lint tasks overlap, only the most
recently started run may apply, preventing an older completion from restoring stale
results.

### Task output capture

The child-process sink identifies each terminal chunk as stdout or stderr. It does
not reorder, suppress, parse, or otherwise alter the stream forwarded to the
pseudoterminal. The existing terminal newline conversion remains the sole text
adaptation. The lint terminal additionally accumulates stdout chunks in arrival
order; stderr remains visible but cannot corrupt the JSON report.

The provider shares one CLI publisher across all lint executions. When a lint task
closes with exit 0 or 1, the terminal parses and applies its captured stdout before
closing. A parse failure is written to the task terminal and shown through VS Code,
and the task exits nonzero. Other tasks and lint cancellation retain the existing
child-process behavior, including SIGTERM followed by SIGKILL escalation.

### Single diagnostics collection

Extension activation creates exactly one diagnostics unit backed by
`vscode.languages.createDiagnosticCollection("foundryscript")`. The task provider
receives that unit for CLI batches. The language client installs
`middleware.handleDiagnostics`, submits LSP batches to the same unit with
`source: "lsp"`, and deliberately does not invoke the default language-client
diagnostic writer. Connection lifecycle changes call
`setLanguageServerConnected`, so the issue #11 arbiter selects LSP diagnostics while
connected and CLI diagnostics otherwise without duplicate collections.

The diagnostics unit and task-provider registration happen before the LSP-off and
missing-workspace early returns, so CLI lint remains available without a server.
Disposal remains owned by the extension context.

## Error handling

- Invalid JSON or schema: show and print a concise ingestion error, publish nothing,
  and preserve prior diagnostics.
- Lint exit 2: preserve prior diagnostics and rely on ordinary CLI stderr/output to
  explain the command failure.
- Cancellation: terminate the child through the existing escalation path, publish
  nothing, and preserve prior diagnostics.
- Missing executable or workspace: retain the actionable task errors from issue #12.
- LSP startup failure or stop: mark the diagnostics unit disconnected; later CLI
  reports may become the active source.

## Verification

Tests use a captured real-shape JSON fixture and no live binary. Focused suites cover:

- JSON version/schema validation and exact severity, file, zero-based range, source,
  and rule-id mapping;
- per-file grouping, successful rerun clearing, overlapping-run ordering, and
  preservation after cancellation, exit 2, or malformed output;
- stdout-only capture while stdout/stderr remain ordered and equivalent in the task
  terminal;
- unchanged cancellation escalation;
- LSP middleware routing through the shared collection without invoking the default
  writer, plus connected/disconnected arbitration;
- absence of problem matchers and continued task availability with LSP mode off.

Repository-wide tests, type checking, linting, build, packaging, and diff checks are
required before review and publication.
