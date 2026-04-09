# Inline Constants

A VS Code extension for C, C++, Objective-C, and CUDA C++ that inlines macro and constant usages at the cursor.

## What it replaces

- Object-like macros such as `#define MY_CONSTANT 123`
- Function-like macros with simple parameters such as `#define ADD_ONE(x) ((x) + 1)`
- `const` variables with an initializer
- `constexpr` variables with an initializer

## How to use it

- Right-click a constant usage and choose `Inline Constant`
- Run `Inline Constants: Inline Constant` from the Command Palette
- Use the Quick Fix or Refactor menu when the cursor is on a replaceable usage

The command is only offered for usages. It will not inline the original definition.

## Click behavior

Set `inlineConstants.clickBehavior` to control the optional click workflow.

- `hoverLink`: Hover a replaceable usage, then click `Inline ...` in the hover tooltip. This is the recommended mode and does not fight `Go to Definition`.
- `disabled`: Disables click-driven replacement.

Notes:

- `hoverLink` does not require a keyboard modifier; you click the action inside the hover tooltip
- The command and context-menu action remain the primary workflow

## Current limits

- Function-like macros that use stringizing, token pasting, or variadic arguments are ignored
- Hover-link mode only appears when the symbol at the cursor can actually be replaced
- Replacement relies on an installed C/C++ definition provider such as Microsoft C/C++ or clangd

## Development

```bash
npm install
npm run compile
npm test
```

`npm test` runs both the fast unit tests for the shared parsing helpers and the VS Code extension-host integration tests.

The integration tests currently cover `const` and `constexpr` replacements, array-style constants, same-file and cross-file definition resolution, supported language IDs (`c`, `cpp`, `cuda-cpp`, `objective-c`, and `objective-cpp`), scope-qualified and template-qualified usages, single-line and multi-line object-like and function-like macros, hover interaction paths, context-key and context-menu availability behavior, action availability boundaries, and refusal cases such as definition sites, malformed declarations, and unsupported variadic, stringizing, or token-pasting macros.

Press `F5` in VS Code to launch the extension development host.
