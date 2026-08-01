# Taskfile Design

## Goal

Add a repository-level `Taskfile.yml` that gives contributors short, discoverable
commands for the existing development workflow and can install the extension built
from the current checkout into standard Visual Studio Code.

## Tasks

The Taskfile will use Task's version 3 schema and define these tasks:

- `install-deps`: install locked npm dependencies with `npm ci`.
- `build`: create the extension bundle through `npm run build`.
- `watch`: run the existing watch build.
- `typecheck`: run strict TypeScript checking.
- `lint`: run ESLint.
- `test`: run unit and grammar tests.
- `check`: run build, typecheck, lint, and tests as the normal verification suite.
- `package`: build an installable VSIX at `dist/foundryscript.vsix`.
- `install`: package the current checkout and force-install that VSIX with the
  standard `code` CLI.

The default task will list available tasks so running `task` is useful without prior
knowledge of the file.

## Installation Flow

`task install` will depend on `package`, which invokes the existing `npm run package`
script with an explicit `--out dist/foundryscript.vsix` argument. After packaging
succeeds, it will run:

```sh
code --install-extension dist/foundryscript.vsix --force
```

The stable output name avoids coupling the task to the package version. The `dist/`
directory is already ignored by Git and is the natural location for generated build
artifacts. Task dependency ordering ensures a failed package never triggers an install.

## Scope and Error Handling

The Taskfile will wrap existing npm scripts rather than duplicate their commands. Shell
failures propagate through Task, so missing tools (`task`, `npm`, or `code`) and failed
builds produce nonzero exits without custom handling. Supporting alternate VS Code
distributions is outside scope; the install command intentionally targets `code`.

No TypeScript, extension runtime behavior, package scripts, or README content will
change.

## Verification

Because this is configuration-only, validation will exercise the Taskfile itself rather
than add application tests:

1. Parse and list tasks with `task --list`.
2. Inspect dry-run output for `check` and `install`.
3. Run `task package` and confirm `dist/foundryscript.vsix` exists.
4. Run the repository-required `npm ci`, build, typecheck, lint, and test commands.

The actual `task install` command mutates the user's local VS Code installation, so it
will not be executed during verification unless explicitly requested.
