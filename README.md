# FoundryScript for Visual Studio Code

Language support for [FoundryScript](https://github.com/cafecito-games/Foundry) (`.fs`),
the gradually-typed scripting language of the Foundry engine.

## Features

- Syntax highlighting for the full FoundryScript grammar, including namespaces, traits,
  tuples, generics, nullable types, `async`/`await`, retroactive conformances (`extend`),
  and custom annotation declarations.
- Comment toggling, bracket matching, off-side folding, and indentation for
  FoundryScript's indentation-sensitive block structure.
- Language intelligence over the Foundry engine's language-server protocol, including
  completion, hover, go-to-definition, and diagnostics.

By default the extension starts `foundry lsp serve` for the open workspace, so `foundry`
must be on `PATH` or configured with `foundryScript.enginePath`. Set
`foundryScript.lsp.mode` to `attach` to connect to an already-running editor/tool host,
`auto` to attach first and spawn only when the configured port refuses the connection,
or `off` to keep syntax highlighting without starting or connecting to Foundry. Attach
and auto use `foundryScript.lsp.port` (default `6005`). Hosts spawned by the extension
are stopped with it; externally started hosts are never terminated by the extension.

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

## Highlighting accuracy

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

All of these are inherent to regex-based, line-oriented TextMate grammars. The fix is
`textDocument/semanticTokens` in the engine's language server — see
[cafecito-games/Foundry#1418](https://github.com/cafecito-games/Foundry/issues/1418).
Every case above is documented in a `comment` field in
[`syntaxes/foundryscript.tmLanguage.json`](syntaxes/foundryscript.tmLanguage.json).

## Development

```
npm ci
npm run build
npm test
```

To run the corpus regression check against an engine checkout:

```
FOUNDRY_ENGINE_PATH=/path/to/Foundry npm run test:corpus
```

This tokenizes roughly 1,326 valid `.fs` files from the engine checkout and fails on any
`invalid.illegal` scope. Without `FOUNDRY_ENGINE_PATH` set, it skips cleanly with an
explanatory message and exits 0 — this is what CI does on every run.

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
