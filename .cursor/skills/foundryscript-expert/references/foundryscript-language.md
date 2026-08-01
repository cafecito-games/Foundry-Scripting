# FoundryScript Language Reference

> Practical summary for extension authors. **Authoritative spec:**
> [cafecito-games/Foundry `modules/foundry_script/GRAMMAR.md`](https://github.com/cafecito-games/Foundry/blob/develop/modules/foundry_script/GRAMMAR.md)
>
> Keep engine `GRAMMAR.md` in sync with any language change. The TextMate grammar in this
> extension is generated/synced from that spec.

## Overview

- **Extension:** `.fs`
- **Paradigm:** Gradually typed, indentation-sensitive (Python-style `NEWLINE`/`INDENT`/`DEDENT`)
- **Lineage:** GDScript derivative with Foundry-specific additions
- **Default base class:** Implicit `RefCounted` when no `extends`

## File structure

A `.fs` file is an implicit **head class**:

```
{ script annotations }
[ namespace dotted.name ]
{ import dotted.name }
[ final | abstract ]
[ class_name | trait_name | enum_name | tuple_name Name ]
[ extends Base [type_args] [ uses Traits ] ]
{ class annotations }
class body
```

Ordering is enforced: `namespace` before `import`; `class_name`/`trait_name`/`enum_name`/`tuple_name` are mutually exclusive.

### Special file forms

| Form | Keyword | Body |
|------|---------|------|
| Global class name | `class_name Foo` | Normal class body |
| Global trait | `trait_name Foo` | Trait body |
| Whole-file enum | `enum_name Dir:` | Indented enum values |
| Global tuple type | `tuple_name Player(x: int, y: int)` | Single-line field list only |

## Foundry-specific features (vs GDScript)

| Feature | Syntax / notes |
|---------|----------------|
| Traits | `trait Name`, `uses TraitName` |
| Retroactive conformance | `extend Target uses Trait:` (contextual `extend`, root-only) |
| Generics | `class Box[T]`, `func swap[T](...)`, `[T: Resource]` bounds |
| Nullable types | `Node?`, `Array[int]?` |
| Async | `async func`, `await expr`, `Coroutine[T]` type |
| Tagged union enums | `enum Message: Quit \n Move(x: int, y: int)` |
| Tuples | `tuple Point(x: float, y: float)`, type `(int, String)` |
| Named call args | `foo(bar = 1)` — unambiguous because `=` is never an expression operator |
| Namespaces | `namespace A.B` + `import A.B` |
| Custom annotations | `annotation foo(...) targets CLASS, METHOD` |
| `final` / `abstract` | On classes, functions, vars |

## Keywords

Reserved (dedicated tokens) — see GRAMMAR.md §2.5 for the complete list. Notable groups:

- Control: `if`, `elif`, `else`, `for`, `while`, `match`, `break`, `continue`, `return`
- Declarations: `class`, `trait`, `func`, `var`, `const`, `signal`, `enum`, `tuple`, `namespace`, `import`
- Modifiers: `static`, `final`, `abstract`, `extends`, `uses`, `preload`, `await`
- Special: `self`, `super`, `pass`, `assert`, `is`, `as`, `in`, `not`, `and`, `or`

**Contextual** (lexed as `IDENTIFIER`, meaning from position):

- `annotation` — custom annotation declaration (root only)
- `extend` — retroactive trait conformance (root only; distinct from `extends`)
- `async` — before `func`
- `targets` — in annotation declarations
- `get` / `set` — property accessors

**Usable as identifiers:** `match`, `when`, `uses`, `PI`, `TAU`, `INF`, `NAN` (and many keywords as attribute/node names).

`yield` is reserved and always an error — use `await`.

## Types

```foundryscript
var count: int = 0
var name := "hello"          # inferred
var maybe: Node? = null

func process(items: Array[String]) -> void: ...
func fetch() -> Coroutine[Resource]: ...

# Callable, Signal, Type handles
var cb: Callable[[int, String], bool]
var sig: Signal[[int]]
var t: Type[MyClass]
```

- Ternary: `true_branch if condition else false_branch` (not `?:`)
- Cast: `value as Type`
- Type test: `value is Type`, `value is not Type`
- Tagged union bind: `msg is Message.Move(x, y)` in `if`/`while`/`assert` conditions

## Expressions (precedence highlights)

Pratt parser with explicit precedence table (GRAMMAR.md §5). Key quirks:

- `**` is **left**-associative: `2 ** 3 ** 2` → `(2 ** 3) ** 2`
- Assignment is statement-level only — never an expression
- `(a)` is grouping; `(a, b)` is a tuple literal (arity ≥ 2); no 1-tuples or empty tuples
- `t.0` is tuple index access (not a float)
- Dictionary: Python style `{ key: value }` OR Lua style `{ key = value }` — one style per literal
- Lambdas: `func(x): ...` as expression
- Get-node: `$Node/Child`, `%UniqueName`, `^"path"` NodePath strings

## Statements

Indentation blocks after `:`. Statement ends at `NEWLINE`, `;`, or EOF.

Notable forms:

- Destructuring: `var (x, y) = expr` (statement only, arity ≥ 2)
- `match` with patterns including array/dict/case patterns and `when` guards
- `for i: int in collection:`

## Annotations

Lexed as single `@name` or `@namespace.name` tokens.

Built-ins include `@export`, `@onready`, `@tool`, `@rpc`, `@warning_ignore`, etc.
(GRAMMAR.md §8). `@deprecated`, `@experimental`, `@tutorial` belong in `##` doc comments,
not as annotations.

## TextMate grammar limitations

When semantic tokens are unavailable, these cases highlight incorrectly (README documents
all cases with `comment` fields in `syntaxes/foundryscript.tmLanguage.json`):

1. Keywords used as identifiers (`var match = 1`)
2. `% y` with space (modulo vs unique-name path)
3. User types named like builtins (`Color`, `int`)
4. `get`/`set` in dictionary/call contexts
5. Generic type parameter brackets unscoped
6. `@` without left boundary

Semantic highlighting from the engine LSP resolves contextual keywords and declaration kinds.

## Engine integration points

Repository: [cafecito-games/Foundry](https://github.com/cafecito-games/Foundry)

| Capability | CLI / location |
|------------|----------------|
| Combined tooling host | `foundry tooling serve --project <project> --lsp-port N --dap-port N` |
| Lint JSON | `foundry script lint --format=json` |
| Grammar spec | [`modules/foundry_script/GRAMMAR.md`](https://github.com/cafecito-games/Foundry/blob/develop/modules/foundry_script/GRAMMAR.md) |
| Tokenizer | [`fs_tokenizer.cpp`](https://github.com/cafecito-games/Foundry/tree/develop/modules/foundry_script) / `fs_tokenizer.h` |
| Parser | `fs_parser.cpp` / `fs_parser.h` |
| Grammar builder | [`modules/foundry_script/grammar/tmlanguage_builder.py`](https://github.com/cafecito-games/Foundry/tree/develop/modules/foundry_script/grammar) |

Custom LSP messages: `foundry_script/capabilities`, `fs_client/changeWorkspace`.

## Grammar sync workflow

1. Language change lands in engine with `GRAMMAR.md` update
2. Engine CI verifies keyword table ↔ GRAMMAR.md §2.5
3. Engine release publishes `foundryscript-tmlanguage-<version>.json`
4. Extension runs `npm run sync-grammar` and commits the result
5. Add grammar regression tests in `tests/grammar/`

Corpus check tokenizes ~1,326 engine `.fs` files when `FOUNDRY_ENGINE_PATH` is set.
