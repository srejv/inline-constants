# Constants Replacement

A VS Code extension for C, C++, Objective-C, and CUDA C++ that inlines constant usages at the cursor.

## What it replaces

- Object-like macros such as `#define MY_CONSTANT 123`
- Function-like macros with simple parameters such as `#define ADD_ONE(x) ((x) + 1)`
- `const` variables with an initializer
- `constexpr` variables with an initializer

## How to use it

- Right-click a constant usage and choose `Replace Constant With Value`
- Run `Constants Replacement: Replace Constant With Value` from the Command Palette
- Use the Quick Fix or Refactor menu when the cursor is on a replaceable usage

The command is only offered for usages. It will not inline the original definition.

## Click behavior

Set `constantsReplacement.clickBehavior` to `editorLink` to enable an optional click gesture for constants declared in the current file.

Notes:

- The modifier key is controlled by VS Code's link behavior, not by the extension directly
- You can disable the click path by setting `constantsReplacement.clickBehavior` back to `disabled`
- The command and context-menu action remain the primary workflow

## Current limits

- Function-like macros that use stringizing, token pasting, or variadic arguments are ignored
- Editor-link mode is intentionally conservative and focuses on constants declared in the active file so it stays responsive
- Replacement relies on an installed C/C++ definition provider such as Microsoft C/C++ or clangd

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch the extension development host.
