# Inline Constants

Inline C and C++ constants directly at the usage site.

Inline Constants replaces supported `#define`, `const`, and `constexpr` usages with their resolved values so you can simplify code without manually copying expressions around.

## Features

- Inline object-like macros such as `#define Padding 24`
- Inline simple function-like macros such as `#define ADD_ONE(x) ((x) + 1)`
- Inline `const` and `constexpr` variables with initializers
- Works with same-file and cross-file definitions when a definition provider can resolve the symbol
- Available from the Command Palette, editor context menu, and code actions
- Optional hover action for quick inline-at-cursor workflow

## Example

Before:

```cpp
constexpr int emptyStatePadding = 24;

int render() {
	return emptyStatePadding;
}
```

After:

```cpp
constexpr int emptyStatePadding = 24;

int render() {
	return 24;
}
```

Function-like macros are expanded with the call-site arguments:

```cpp
#define ADD_ONE(x) ((x) + 1)

int render(int value) {
	return ADD_ONE(value);
}
```

becomes:

```cpp
int render(int value) {
	return ((value) + 1);
}
```

## Supported Languages

- C
- C++
- CUDA C++
- Objective-C
- Objective-C++

## Requirements

Inline Constants relies on a definition provider to locate the original symbol declaration.

For best results, install a C/C++ language extension that provides definition resolution, such as:

- Microsoft C/C++
- clangd

## Usage

Place the cursor on a supported constant usage, then use one of these entry points:

- Run `Inline Constants: Inline Constant` from the Command Palette
- Right-click and choose `Inline Constant`
- Trigger a code action or refactor at the cursor
- Hover the symbol and click the inline action when hover mode is enabled

The action is only offered on inlineable usages. It is not offered on the original definition.

## Extension Settings

This extension contributes the following settings:

- `inlineConstants.clickBehavior`: Controls the optional click workflow. `hoverLink` shows an inline action in the hover tooltip. `disabled` turns off click-driven inlining.
- `inlineConstants.parenthesizeExpressions`: Wraps inserted expressions in parentheses when they contain top-level operators.

## Current Limitations

- Function-like macros that use variadic arguments, stringizing, or token pasting are ignored
- Malformed declarations and unsupported initializer forms are ignored
- Hover actions only appear when the symbol at the cursor can actually be inlined
- Replacement quality depends on the underlying definition provider being able to resolve the symbol correctly

## Development

```bash
npm install
npm run compile
npm test
```

Press `F5` in VS Code to launch the extension development host.
