import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expandFunctionMacroBody,
  extendQualifiedConstUsageRangeOffsets,
  normalizeReplacementExpression,
  parseMacroInvocationText,
} from '../core';

test('extends const replacement range across namespaces', () => {
  const code = 'auto value = UiStyle::Typography::emptyStateFontSize;';
  const symbol = 'emptyStateFontSize';
  const startOffset = code.indexOf(symbol);
  const range = extendQualifiedConstUsageRangeOffsets(code, startOffset, startOffset + symbol.length);

  assert.equal(code.slice(range.startOffset, range.endOffset), 'UiStyle::Typography::emptyStateFontSize');
});

test('extends const replacement range across template-qualified namespaces', () => {
  const code = 'auto value = Theme<ColorMode::Dark>::Typography::emptyStateFontSize;';
  const symbol = 'emptyStateFontSize';
  const startOffset = code.indexOf(symbol);
  const range = extendQualifiedConstUsageRangeOffsets(code, startOffset, startOffset + symbol.length);

  assert.equal(
    code.slice(range.startOffset, range.endOffset),
    'Theme<ColorMode::Dark>::Typography::emptyStateFontSize',
  );
});

test('extends const replacement range across nested template-qualified namespaces', () => {
  const code = 'auto value = Theme<Palette<ColorMode::Dark>, 4>::Typography::emptyStateFontSize;';
  const symbol = 'emptyStateFontSize';
  const startOffset = code.indexOf(symbol);
  const range = extendQualifiedConstUsageRangeOffsets(code, startOffset, startOffset + symbol.length);

  assert.equal(
    code.slice(range.startOffset, range.endOffset),
    'Theme<Palette<ColorMode::Dark>, 4>::Typography::emptyStateFontSize',
  );
});

test('does not consume member access when replacing const usage', () => {
  const code = 'auto value = typography.emptyStateFontSize;';
  const symbol = 'emptyStateFontSize';
  const startOffset = code.indexOf(symbol);
  const range = extendQualifiedConstUsageRangeOffsets(code, startOffset, startOffset + symbol.length);

  assert.equal(code.slice(range.startOffset, range.endOffset), 'emptyStateFontSize');
});

test('normalizes replacement expressions with parentheses when needed', () => {
  assert.equal(normalizeReplacementExpression('left + right', true), '(left + right)');
  assert.equal(normalizeReplacementExpression('(left + right)', true), '(left + right)');
  assert.equal(normalizeReplacementExpression('42', true), '42');
  assert.equal(normalizeReplacementExpression('left + right', false), 'left + right');
});

test('parses macro invocations with nested commas and templates', () => {
  const code = 'auto value = MAKE_PAIR(call(1, 2), std::array<int, 3>{1, 2, 3});';
  const symbolEndOffset = code.indexOf('MAKE_PAIR') + 'MAKE_PAIR'.length;
  const invocation = parseMacroInvocationText(code, symbolEndOffset);

  assert.deepEqual(invocation?.arguments, [
    'call(1, 2)',
    'std::array<int, 3>{1, 2, 3}',
  ]);
  assert.equal(code.slice(code.indexOf('MAKE_PAIR'), invocation?.rangeEndOffset), 'MAKE_PAIR(call(1, 2), std::array<int, 3>{1, 2, 3})');
});

test('parses function-like macro invocations split across lines', () => {
  const code = 'auto value = MIX(\n  left + right,\n  computeScale()\n);';
  const symbolEndOffset = code.indexOf('MIX') + 'MIX'.length;
  const invocation = parseMacroInvocationText(code, symbolEndOffset);

  assert.deepEqual(invocation?.arguments, ['left + right', 'computeScale()']);
});

test('expands function-like macros with wrapped call-site arguments', () => {
  const expanded = expandFunctionMacroBody('((x) + (y))', ['x', 'y'], ['alpha + beta', 'gamma']);
  assert.equal(expanded, '(((alpha + beta)) + ((gamma)))');
});
