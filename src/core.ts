export interface MacroInvocationText {
  arguments: string[];
  rangeEndOffset: number;
}

export interface OffsetRange {
  endOffset: number;
  startOffset: number;
}

export function parseMacroInvocationText(
  text: string,
  symbolEndOffset: number,
): MacroInvocationText | undefined {
  const cursor = skipWhitespace(text, symbolEndOffset);
  if (cursor >= text.length || text[cursor] !== '(') {
    return undefined;
  }

  const closingIndex = findMatchingCharacter(text, cursor, '(', ')');
  if (closingIndex < 0) {
    return undefined;
  }

  const argumentsText = text.slice(cursor + 1, closingIndex);
  const parsedArguments = splitTopLevel(argumentsText, ',')
    .map((argument) => argument.trim())
    .filter((argument, index, all) => !(all.length === 1 && index === 0 && argument.length === 0));

  return {
    arguments: parsedArguments,
    rangeEndOffset: closingIndex + 1,
  };
}

export function expandFunctionMacroBody(
  body: string,
  parameters: string[],
  argumentsAtCallSite: string[],
): string {
  let expanded = body;

  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index];
    const argument = wrapMacroArgument(argumentsAtCallSite[index] ?? '');
    expanded = replaceWholeWord(expanded, parameter, argument);
  }

  return expanded.trim();
}

export function normalizeReplacementExpression(
  rawText: string,
  parenthesizeExpressions: boolean,
): string | undefined {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return undefined;
  }

  if (!parenthesizeExpressions || !hasTopLevelOperator(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith('{') || isWrappedByMatchingPair(trimmed, '(', ')')) {
    return trimmed;
  }

  return `(${trimmed})`;
}

export function extendQualifiedConstUsageRangeOffsets(
  text: string,
  startOffset: number,
  endOffset: number,
): OffsetRange {
  let qualifiedStartOffset = startOffset;

  while (qualifiedStartOffset > 0) {
    const beforeOperatorOffset = skipWhitespaceBackward(text, qualifiedStartOffset);
    if (
      beforeOperatorOffset < 2 ||
      text[beforeOperatorOffset - 2] !== ':' ||
      text[beforeOperatorOffset - 1] !== ':'
    ) {
      break;
    }

    const segmentEndOffset = skipWhitespaceBackward(text, beforeOperatorOffset - 2);
    const segmentStartOffset = findQualifiedSegmentStart(text, segmentEndOffset);
    if (segmentStartOffset === undefined) {
      break;
    }

    qualifiedStartOffset = segmentStartOffset;
  }

  return {
    endOffset,
    startOffset: qualifiedStartOffset,
  };
}

function skipWhitespace(text: string, index: number): number {
  let currentIndex = index;
  while (currentIndex < text.length && /\s/.test(text[currentIndex])) {
    currentIndex += 1;
  }
  return currentIndex;
}

function skipWhitespaceBackward(text: string, index: number): number {
  let currentIndex = index;
  while (currentIndex > 0 && /\s/.test(text[currentIndex - 1])) {
    currentIndex -= 1;
  }
  return currentIndex;
}

function findQualifiedSegmentStart(text: string, segmentEndOffset: number): number | undefined {
  if (segmentEndOffset <= 0) {
    return undefined;
  }

  const segmentEndCharacter = text[segmentEndOffset - 1];
  if (segmentEndCharacter === '>') {
    const templateStartOffset = findMatchingAngleBracketStart(text, segmentEndOffset - 1);
    if (templateStartOffset < 0) {
      return undefined;
    }

    const identifierEndOffset = skipWhitespaceBackward(text, templateStartOffset);
    return findIdentifierStart(text, identifierEndOffset);
  }

  return findIdentifierStart(text, segmentEndOffset);
}

function findIdentifierStart(text: string, identifierEndOffset: number): number | undefined {
  if (identifierEndOffset <= 0 || !isIdentifierPart(text[identifierEndOffset - 1])) {
    return undefined;
  }

  let cursor = identifierEndOffset - 1;
  while (cursor >= 0 && isIdentifierPart(text[cursor])) {
    cursor -= 1;
  }

  const startOffset = cursor + 1;
  return isIdentifierStart(text[startOffset]) ? startOffset : undefined;
}

function findMatchingAngleBracketStart(text: string, closingIndex: number): number {
  let depth = 0;

  for (let index = closingIndex; index >= 0; index -= 1) {
    const current = text[index];
    if (current === '>') {
      depth += 1;
      continue;
    }

    if (current === '<') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z_]/.test(character);
}

function findMatchingCharacter(
  text: string,
  startIndex: number,
  openCharacter: string,
  closeCharacter: string,
): number {
  let depth = 0;
  let inBlockComment = false;
  let inLineComment = false;
  let stringDelimiter: '"' | "'" | undefined;

  for (let index = startIndex; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (stringDelimiter) {
      if (current === '\\') {
        index += 1;
        continue;
      }
      if (current === stringDelimiter) {
        stringDelimiter = undefined;
      }
      continue;
    }

    if (current === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (current === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (current === '"' || current === "'") {
      stringDelimiter = current;
      continue;
    }

    if (current === openCharacter) {
      depth += 1;
      continue;
    }

    if (current === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let angleDepth = 0;
  let inBlockComment = false;
  let inLineComment = false;
  let stringDelimiter: '"' | "'" | undefined;
  let partStart = 0;

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (stringDelimiter) {
      if (current === '\\') {
        index += 1;
        continue;
      }
      if (current === stringDelimiter) {
        stringDelimiter = undefined;
      }
      continue;
    }

    if (current === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (current === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (current === '"' || current === "'") {
      stringDelimiter = current;
      continue;
    }

    if (current === '(') {
      roundDepth += 1;
      continue;
    }
    if (current === ')' && roundDepth > 0) {
      roundDepth -= 1;
      continue;
    }
    if (current === '[') {
      squareDepth += 1;
      continue;
    }
    if (current === ']' && squareDepth > 0) {
      squareDepth -= 1;
      continue;
    }
    if (current === '{') {
      curlyDepth += 1;
      continue;
    }
    if (current === '}' && curlyDepth > 0) {
      curlyDepth -= 1;
      continue;
    }
    if (current === '<') {
      angleDepth += 1;
      continue;
    }
    if (current === '>' && angleDepth > 0) {
      angleDepth -= 1;
      continue;
    }

    if (
      current === separator &&
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0 &&
      angleDepth === 0
    ) {
      parts.push(text.slice(partStart, index));
      partStart = index + 1;
    }
  }

  parts.push(text.slice(partStart));
  return parts;
}

function hasTopLevelOperator(text: string): boolean {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let angleDepth = 0;
  let inBlockComment = false;
  let inLineComment = false;
  let stringDelimiter: '"' | "'" | undefined;

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];

    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (current === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (stringDelimiter) {
      if (current === '\\') {
        index += 1;
        continue;
      }
      if (current === stringDelimiter) {
        stringDelimiter = undefined;
      }
      continue;
    }

    if (current === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (current === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }

    if (current === '"' || current === "'") {
      stringDelimiter = current;
      continue;
    }

    if (current === '(') {
      roundDepth += 1;
      continue;
    }
    if (current === ')' && roundDepth > 0) {
      roundDepth -= 1;
      continue;
    }
    if (current === '[') {
      squareDepth += 1;
      continue;
    }
    if (current === ']' && squareDepth > 0) {
      squareDepth -= 1;
      continue;
    }
    if (current === '{') {
      curlyDepth += 1;
      continue;
    }
    if (current === '}' && curlyDepth > 0) {
      curlyDepth -= 1;
      continue;
    }
    if (current === '<') {
      angleDepth += 1;
      continue;
    }
    if (current === '>' && angleDepth > 0) {
      angleDepth -= 1;
      continue;
    }

    if (roundDepth > 0 || squareDepth > 0 || curlyDepth > 0 || angleDepth > 0) {
      continue;
    }

    if (',?:+-*/%&|^=!<>'.includes(current)) {
      return true;
    }
  }

  return false;
}

function isWrappedByMatchingPair(text: string, openCharacter: string, closeCharacter: string): boolean {
  if (!text.startsWith(openCharacter) || !text.endsWith(closeCharacter)) {
    return false;
  }

  return findMatchingCharacter(text, 0, openCharacter, closeCharacter) === text.length - 1;
}

function wrapMacroArgument(argument: string): string {
  const trimmed = argument.trim();
  if (!trimmed) {
    return trimmed;
  }

  return isWrappedByMatchingPair(trimmed, '(', ')') ? trimmed : `(${trimmed})`;
}

function replaceWholeWord(text: string, word: string, replacement: string): string {
  const pattern = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'g');
  return text.replace(pattern, replacement);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
