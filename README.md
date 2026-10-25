# Auric for VS Code

Language support for [Auric](https://github.com/TeamAuroraOS/AuroraOS/tree/main/auric-lang),
the small statically-typed language for building
[AuroraOS](https://github.com/TeamAuroraOS/AuroraOS) apps on the Nintendo 3DS.

*Coding too hard? Try Auric!*

## Features

**Syntax coloring** for `.aur` files: keywords, types, built-ins, the predefined
colours, buttons and screens, numbers, strings, comments and operators each get
their own color. Semantic coloring then picks out your functions, parameters and
variables; a global that is never reassigned is colored like a constant.

**Errors as you type.** The extension has its own copy of the `aurc` front end
(lexer, parser and type checker), so it flags everything `aurc` would reject
before the C compiler runs, with `aurc`'s own messages:

* syntax errors: a missing `;` or `}`, an unterminated string, a stray character;
* type errors: mixing `int` and `float`, a non-`bool` condition, the wrong number
  or type of arguments, an undeclared name, a missing `fn main()`, a non-constant
  global, `break` outside a loop, and the rest.

Where `aurc` stops at its first error, the extension shows them all, and keeps
going past a syntax error without piling up errors it caused. No Python or
compiler is needed for this.

**Hover** a built-in, a constant or one of your own names to see its signature
or type. Comments right above one of your functions or variables, or after it
on the same line, show up as its docs.

**Autocomplete** for keywords, built-ins (with their parameters filled in),
constants, your functions, and the variables in scope at the cursor, plus
**signature help** while you type a call's arguments.

**Snippets**: `main`, `fn`, `fnr`, `let`, `lett`, `array`, `if`, `ifelse`,
`elseif`, `while`, `for` (a counting `while` loop), `key`, `gameloop`, `button`,
`sound` and `httpget`.

**Build App** (the ▶ button on an open `.aur` file, or *Auric: Build App* from
the Command Palette) runs `aurc build`, and *Auric: Show Generated C* opens the C
that `aurc emit-c` produces. If `<name>.icon` sits next to `<name>.aur`, the build
embeds it as the app icon.

## Building apps

Coloring and error checking need nothing else. To build, the extension runs the
real compiler, found in this order:

1. `auric.compiler.path`, the standalone `aurc.exe`;
2. `auric.compiler.auricLangPath`, the `auric-lang` folder of an AuroraOS
   checkout, run as `python -m compiler.aurc` with Python 3.10+;
3. an `auric-lang` folder in or above the file's folder, or in the workspace
   (so files inside an AuroraOS checkout just work);
4. `aurc` on `PATH`.

Building also needs [devkitARM](https://devkitpro.org/wiki/Getting_Started)
(`arm-none-eabi-gcc`) on `PATH`. Copy the `.bin` it makes to
`SD:\Aurora\Apps\` and pick it on the AuroraOS home menu.

## Settings

| Setting | Default | |
|---|---|---|
| `auric.diagnostics.enabled` | `true` | Check `.aur` files as you type. |
| `auric.compiler.path` | | Path to `aurc.exe`. |
| `auric.compiler.auricLangPath` | | Path to an `auric-lang` folder. |
| `auric.compiler.pythonPath` | `python` | The Python that runs `compiler.aurc`. |
| `auric.build.outputDirectory` | | Where the `.bin` goes; next to the source when empty. |
| `auric.build.useIconFile` | `true` | Pass `<name>.icon` to `--icon` when it exists. |
| `auric.build.extraArgs` | `[]` | More `aurc build` arguments, e.g. `["--magic", "AOS1"]`. |

Path settings accept `~` and `${workspaceFolder}`. In an untrusted workspace the
build commands are off; coloring and checking still work.

## Installing from a `.vsix`

```
code --install-extension auric-0.1.0.vsix
```

or *Extensions* view → `...` → *Install from VSIX...*.

## Development

```
npm install
npm test               # unit tests: checker, editor services, grammar
npm run test:parity    # the checker against the real aurc (needs Python and auric-lang)
npm run test:vscode    # end to end inside VS Code ($VSCODE_PATH to use an installed one)
npm run package        # build auric-<version>.vsix
```

The parity and VS Code tests look for `auric-lang` in `$AURIC_LANG`, else
`../aurora/auric-lang` (the parity test also takes it as `-- <dir>`); the parity
test runs `$PYTHON`, else `python`.

Press F5 in VS Code to try the extension in a development window.

The checker in `src/language/` mirrors `auric-lang/compiler/` (`lexer.py`,
`parser.py`, `typecheck.py`, `prelude.py`). When Auric changes, update it to
match and run `npm run test:parity`. That test mutates the example programs
in `test/fixtures/` thousands of ways and checks that whenever `aurc` accepts a
program the extension reports nothing, and whenever `aurc` rejects one the
extension reports that same error on the same line. The grammar test checks
that the grammar's built-in and constant lists match `prelude.ts`.

## Publishing to the Marketplace

1. Create a publisher at <https://marketplace.visualstudio.com/manage> and put
   its ID in `package.json` → `publisher` (it is `teamauroraos` for now).
2. Create an Azure DevOps personal access token with the *Marketplace (Manage)*
   scope, then `npx vsce login <publisher>`.
3. Bump `version` in `package.json`, note the changes in `CHANGELOG.md`, and run
   `npx vsce publish`.

## License

GPL-3.0, like AuroraOS, whose compiler the checker is ported from.
