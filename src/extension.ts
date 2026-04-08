import * as vscode from 'vscode';

import {
  expandFunctionMacroBody,
  extendQualifiedConstUsageRangeOffsets,
  normalizeReplacementExpression,
  parseMacroInvocationText,
} from './core';

const COMMAND_REPLACE = 'constantsReplacement.replaceAtCursor';
const CONTEXT_CAN_REPLACE = 'constantsReplacement.canReplaceAtCursor';
const SUPPORTED_LANGUAGE_IDS = new Set(['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp']);
const DOCUMENT_SELECTOR: vscode.DocumentSelector = Array.from(SUPPORTED_LANGUAGE_IDS);

let contextUpdateTimer: NodeJS.Timeout | undefined;
let contextUpdateVersion = 0;

interface PositionJson {
  line: number;
  character: number;
}

interface ReplaceCommandArgs {
  uri?: string;
  position?: PositionJson;
}

type ReplacementSourceType = 'macroObject' | 'macroFunction' | 'constVariable';

interface ReplacementPlan {
  displayName: string;
  replacementRange: vscode.Range;
  replacementText: string;
  symbolRange: vscode.Range;
  sourceType: ReplacementSourceType;
}

interface BaseDefinitionInfo {
  definitionRange: vscode.Range;
  kind: ReplacementSourceType;
  location: vscode.Location;
  name: string;
}

interface MacroObjectDefinitionInfo extends BaseDefinitionInfo {
  body: string;
  kind: 'macroObject';
}

interface MacroFunctionDefinitionInfo extends BaseDefinitionInfo {
  body: string;
  kind: 'macroFunction';
  parameters: string[];
}

interface ConstVariableDefinitionInfo extends BaseDefinitionInfo {
  initializer: string;
  kind: 'constVariable';
}

type DefinitionInfo =
  | MacroObjectDefinitionInfo
  | MacroFunctionDefinitionInfo
  | ConstVariableDefinitionInfo;

interface MacroInvocation {
  arguments: string[];
  range: vscode.Range;
}

interface LocalLinkCandidate {
  definitionRange: vscode.Range;
  name: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const evaluator = new ReplacementEvaluator();

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_REPLACE, async (args?: ReplaceCommandArgs) => {
      await executeReplaceCommand(evaluator, args);
    }),
    vscode.languages.registerCodeActionsProvider(
      DOCUMENT_SELECTOR,
      new ConstantCodeActionProvider(evaluator),
      {
        providedCodeActionKinds: [
          vscode.CodeActionKind.RefactorInline,
          vscode.CodeActionKind.QuickFix,
        ],
      },
    ),
    vscode.languages.registerDocumentLinkProvider(
      DOCUMENT_SELECTOR,
      new ConstantLinkProvider(),
    ),
    vscode.languages.registerHoverProvider(
      DOCUMENT_SELECTOR,
      new ConstantHoverProvider(evaluator),
    ),
    vscode.window.onDidChangeActiveTextEditor(() => {
      scheduleContextUpdate(evaluator);
    }),
    vscode.window.onDidChangeTextEditorSelection(() => {
      scheduleContextUpdate(evaluator);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && sameUri(activeEditor.document.uri, event.document.uri)) {
        scheduleContextUpdate(evaluator);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('constantsReplacement')) {
        scheduleContextUpdate(evaluator);
      }
    }),
  );

  scheduleContextUpdate(evaluator);
}

class ConstantCodeActionProvider implements vscode.CodeActionProvider {
  public constructor(private readonly evaluator: ReplacementEvaluator) {}

  public async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): Promise<vscode.CodeAction[]> {
    const position = range instanceof vscode.Selection ? range.active : range.start;
    const plan = await this.evaluator.buildPlan(document, position);
    if (!plan) {
      return [];
    }

    const action = new vscode.CodeAction(
      `Replace ${plan.displayName} with value`,
      vscode.CodeActionKind.RefactorInline,
    );
    action.command = {
      arguments: [
        {
          position: {
            character: position.character,
            line: position.line,
          },
          uri: document.uri.toString(),
        } satisfies ReplaceCommandArgs,
      ],
      command: COMMAND_REPLACE,
      title: 'Replace Constant With Value',
    };
    action.isPreferred = true;

    return [action];
  }
}

class ConstantLinkProvider implements vscode.DocumentLinkProvider {
  public provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    if (!isSupportedDocument(document) || getClickBehavior() !== 'editorLink') {
      return [];
    }

    const candidates = collectLocalLinkCandidates(document);
    if (candidates.length === 0) {
      return [];
    }

    const links: vscode.DocumentLink[] = [];
    const text = document.getText();

    for (const candidate of candidates) {
      const pattern = new RegExp(`\\b${escapeRegExp(candidate.name)}\\b`, 'g');
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(text)) !== null) {
        const start = document.positionAt(match.index);
        const end = document.positionAt(match.index + candidate.name.length);
        const range = new vscode.Range(start, end);

        if (range.isEqual(candidate.definitionRange)) {
          continue;
        }

        links.push(
          new vscode.DocumentLink(range, buildCommandUri(document.uri, start)),
        );
      }
    }

    for (const link of links) {
      link.tooltip = 'Replace constant with value';
    }

    return links;
  }
}

class ConstantHoverProvider implements vscode.HoverProvider {
  public constructor(private readonly evaluator: ReplacementEvaluator) {}

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    if (!isSupportedDocument(document) || getClickBehavior() !== 'hoverLink') {
      return undefined;
    }

    const plan = await this.evaluator.buildPlan(document, position);
    if (!plan) {
      return undefined;
    }

    const commandUri = buildCommandUri(document.uri, position);
    const link = new vscode.MarkdownString(
      `[Replace ${plan.displayName} with value](${commandUri})`,
      true,
    );
    link.isTrusted = { enabledCommands: [COMMAND_REPLACE] };

    const preview = new vscode.MarkdownString(
      `Inlines to: \`${escapeMarkdownCode(plan.replacementText)}\``,
      true,
    );

    return new vscode.Hover([link, preview], plan.symbolRange);
  }
}

class ReplacementEvaluator {
  public async buildPlan(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<ReplacementPlan | undefined> {
    if (!isSupportedDocument(document)) {
      return undefined;
    }

    const symbolRange = getIdentifierRange(document, position);
    if (!symbolRange) {
      return undefined;
    }

    const symbolName = document.getText(symbolRange);
    const definitionLocation = await getDefinitionLocation(document.uri, position);
    if (!definitionLocation) {
      return undefined;
    }

    if (sameUri(document.uri, definitionLocation.uri) && definitionLocation.range.contains(position)) {
      return undefined;
    }

    const definitionDocument = await vscode.workspace.openTextDocument(definitionLocation.uri);
    const definitionInfo = extractDefinitionInfo(definitionDocument, definitionLocation, symbolName);
    if (!definitionInfo) {
      return undefined;
    }

    if (
      sameUri(document.uri, definitionInfo.location.uri) &&
      definitionInfo.definitionRange.contains(position)
    ) {
      return undefined;
    }

    switch (definitionInfo.kind) {
      case 'macroFunction': {
        const invocation = parseMacroInvocation(document, symbolRange);
        if (!invocation || invocation.arguments.length !== definitionInfo.parameters.length) {
          return undefined;
        }

        const expanded = expandFunctionMacro(definitionInfo, invocation.arguments);
        const replacementText = normalizeReplacementText(expanded);
        if (!replacementText) {
          return undefined;
        }

        return {
          displayName: symbolName,
          replacementRange: invocation.range,
          replacementText,
          sourceType: 'macroFunction',
          symbolRange,
        };
      }
      case 'macroObject': {
        const replacementText = normalizeReplacementText(definitionInfo.body);
        if (!replacementText) {
          return undefined;
        }

        return {
          displayName: symbolName,
          replacementRange: symbolRange,
          replacementText,
          sourceType: 'macroObject',
          symbolRange,
        };
      }
      case 'constVariable': {
        const replacementText = normalizeReplacementText(definitionInfo.initializer);
        if (!replacementText) {
          return undefined;
        }

        const qualifiedUsageRange = extendQualifiedConstUsageRange(document, symbolRange);

        return {
          displayName: symbolName,
          replacementRange: qualifiedUsageRange,
          replacementText,
          sourceType: 'constVariable',
          symbolRange,
        };
      }
      default:
        return undefined;
    }
  }
}

async function executeReplaceCommand(
  evaluator: ReplacementEvaluator,
  args?: ReplaceCommandArgs,
): Promise<void> {
  const editor = await resolveEditor(args?.uri);
  if (!editor) {
    return;
  }

  const position = args?.position
    ? new vscode.Position(args.position.line, args.position.character)
    : editor.selection.active;
  const plan = await evaluator.buildPlan(editor.document, position);

  if (!plan) {
    void vscode.window.showInformationMessage(
      'No replaceable constant usage was found at the current cursor.',
    );
    return;
  }

  const didApply = await editor.edit((editBuilder) => {
    editBuilder.replace(plan.replacementRange, plan.replacementText);
  });

  if (!didApply) {
    void vscode.window.showErrorMessage('Constants Replacement could not apply the edit.');
  }
}

async function resolveEditor(uriString?: string): Promise<vscode.TextEditor | undefined> {
  if (!uriString) {
    return vscode.window.activeTextEditor;
  }

  const targetUri = vscode.Uri.parse(uriString);
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && sameUri(activeEditor.document.uri, targetUri)) {
    return activeEditor;
  }

  const document = await vscode.workspace.openTextDocument(targetUri);
  return vscode.window.showTextDocument(document, { preview: false });
}

function scheduleContextUpdate(evaluator: ReplacementEvaluator): void {
  if (contextUpdateTimer) {
    clearTimeout(contextUpdateTimer);
  }

  const currentVersion = ++contextUpdateVersion;
  contextUpdateTimer = setTimeout(async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSupportedDocument(editor.document)) {
      if (currentVersion === contextUpdateVersion) {
        await vscode.commands.executeCommand('setContext', CONTEXT_CAN_REPLACE, false);
      }
      return;
    }

    let canReplace = false;
    try {
      canReplace = Boolean(await evaluator.buildPlan(editor.document, editor.selection.active));
    } catch {
      canReplace = false;
    }

    if (currentVersion === contextUpdateVersion) {
      await vscode.commands.executeCommand('setContext', CONTEXT_CAN_REPLACE, canReplace);
    }
  }, 150);
}

function extractDefinitionInfo(
  document: vscode.TextDocument,
  definitionLocation: vscode.Location,
  symbolName: string,
): DefinitionInfo | undefined {
  const macroDefinition = tryParseMacroDefinition(
    document,
    definitionLocation.range.start.line,
    symbolName,
  );
  if (macroDefinition) {
    return macroDefinition;
  }

  return tryParseConstDefinition(document, definitionLocation.range.start, symbolName);
}

function tryParseMacroDefinition(
  document: vscode.TextDocument,
  lineNumber: number,
  symbolName: string,
): DefinitionInfo | undefined {
  const firstLine = document.lineAt(lineNumber).text;
  if (!/^\s*#\s*define\b/.test(firstLine)) {
    return undefined;
  }

  const parts: string[] = [];
  let currentLine = lineNumber;

  while (currentLine < document.lineCount) {
    const lineText = document.lineAt(currentLine).text;
    const hasContinuation = /\\\s*$/.test(lineText);
    parts.push(lineText.replace(/\\\s*$/, ''));
    if (!hasContinuation) {
      break;
    }
    currentLine += 1;
  }

  const normalized = parts.join(' ');
  const definitionMatch = normalized.match(
    /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(\(([^)]*)\))?\s*(.*)$/,
  );
  if (!definitionMatch || definitionMatch[1] !== symbolName) {
    return undefined;
  }

  const nameIndex = firstLine.indexOf(symbolName);
  if (nameIndex < 0) {
    return undefined;
  }

  const definitionRange = new vscode.Range(
    new vscode.Position(lineNumber, nameIndex),
    new vscode.Position(lineNumber, nameIndex + symbolName.length),
  );
  const location = new vscode.Location(document.uri, definitionRange);
  const body = definitionMatch[4].trim();
  if (!body) {
    return undefined;
  }

  if (definitionMatch[2]) {
    const parametersText = definitionMatch[3].trim();
    const parameters = parametersText
      ? parametersText.split(',').map((parameter) => parameter.trim()).filter(Boolean)
      : [];

    if (parameters.some((parameter) => parameter.includes('...')) || body.includes('#')) {
      return undefined;
    }

    return {
      body,
      definitionRange,
      kind: 'macroFunction',
      location,
      name: symbolName,
      parameters,
    };
  }

  return {
    body,
    definitionRange,
    kind: 'macroObject',
    location,
    name: symbolName,
  };
}

function tryParseConstDefinition(
  document: vscode.TextDocument,
  position: vscode.Position,
  symbolName: string,
): ConstVariableDefinitionInfo | undefined {
  const startLine = findDeclarationStartLine(document, position.line);
  const startOffset = document.offsetAt(new vscode.Position(startLine, 0));
  const endOffset = findStatementEndOffset(document, startLine);
  if (endOffset === undefined) {
    return undefined;
  }

  const declarationText = document.getText(
    new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset + 1)),
  );
  if (!/\b(?:const|constexpr)\b/.test(declarationText)) {
    return undefined;
  }

  const relativeCursorOffset = document.offsetAt(position) - startOffset;
  const occurrence = findNameOccurrenceAtOffset(declarationText, symbolName, relativeCursorOffset);
  if (!occurrence) {
    return undefined;
  }

  let cursor = skipWhitespace(declarationText, occurrence.end);
  while (cursor < declarationText.length && declarationText[cursor] === '[') {
    const arrayEnd = findMatchingCharacter(declarationText, cursor, '[', ']');
    if (arrayEnd < 0) {
      return undefined;
    }
    cursor = skipWhitespace(declarationText, arrayEnd + 1);
  }

  let initializer = '';
  const marker = declarationText[cursor];
  if (marker === '=') {
    const initializerStart = skipWhitespace(declarationText, cursor + 1);
    const initializerEnd = findTopLevelCharacter(declarationText, initializerStart, ';');
    if (initializerEnd < 0) {
      return undefined;
    }
    initializer = declarationText.slice(initializerStart, initializerEnd).trim();
  } else if (marker === '{' || marker === '(') {
    const closing = findMatchingCharacter(declarationText, cursor, marker, marker === '{' ? '}' : ')');
    if (closing < 0) {
      return undefined;
    }

    const directInitializer = declarationText.slice(cursor + 1, closing).trim();
    if (!directInitializer || containsTopLevelComma(directInitializer)) {
      return undefined;
    }

    initializer = directInitializer;
  } else {
    return undefined;
  }

  if (!initializer) {
    return undefined;
  }

  const definitionRange = new vscode.Range(
    document.positionAt(startOffset + occurrence.start),
    document.positionAt(startOffset + occurrence.end),
  );

  return {
    definitionRange,
    initializer,
    kind: 'constVariable',
    location: new vscode.Location(document.uri, definitionRange),
    name: symbolName,
  };
}

function parseMacroInvocation(
  document: vscode.TextDocument,
  symbolRange: vscode.Range,
): MacroInvocation | undefined {
  const text = document.getText();
  const invocation = parseMacroInvocationText(text, document.offsetAt(symbolRange.end));
  if (!invocation) {
    return undefined;
  }

  return {
    arguments: invocation.arguments,
    range: new vscode.Range(symbolRange.start, document.positionAt(invocation.rangeEndOffset)),
  };
}

function expandFunctionMacro(
  definitionInfo: MacroFunctionDefinitionInfo,
  argumentsAtCallSite: string[],
): string {
  return expandFunctionMacroBody(
    definitionInfo.body,
    definitionInfo.parameters,
    argumentsAtCallSite,
  );
}

function normalizeReplacementText(rawText: string): string | undefined {
  return normalizeReplacementExpression(rawText, getParenthesizeExpressions());
}

async function getDefinitionLocation(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<vscode.Location | undefined> {
  const locations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider',
    uri,
    position,
  );
  if (!locations || locations.length === 0) {
    return undefined;
  }

  for (const location of locations) {
    const normalized = normalizeLocation(location);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function normalizeLocation(
  value: vscode.Location | vscode.LocationLink,
): vscode.Location | undefined {
  if ('uri' in value && 'range' in value) {
    return new vscode.Location(value.uri, value.range);
  }

  if ('targetUri' in value) {
    const targetRange = value.targetSelectionRange ?? value.targetRange;
    return new vscode.Location(value.targetUri, targetRange);
  }

  return undefined;
}

function collectLocalLinkCandidates(document: vscode.TextDocument): LocalLinkCandidate[] {
  const candidates = new Map<string, LocalLinkCandidate>();

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
    const lineText = document.lineAt(lineNumber).text;

    const macroMatch = lineText.match(/^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)(\([^)]*\))?/);
    if (macroMatch) {
      const name = macroMatch[1];
      const startCharacter = lineText.indexOf(name);
      if (startCharacter >= 0 && !candidates.has(name)) {
        candidates.set(name, {
          definitionRange: new vscode.Range(
            new vscode.Position(lineNumber, startCharacter),
            new vscode.Position(lineNumber, startCharacter + name.length),
          ),
          name,
        });
      }
      continue;
    }

    const constMatch = lineText.match(
      /\b(?:constexpr|const)\b.*?\b([A-Za-z_][A-Za-z0-9_]*)\b(?:\s*\[[^\]]*\])*\s*(?:=|\{|\()/,
    );
    if (!constMatch) {
      continue;
    }

    const name = constMatch[1];
    const startCharacter = lineText.indexOf(name);
    if (startCharacter >= 0 && !candidates.has(name)) {
      candidates.set(name, {
        definitionRange: new vscode.Range(
          new vscode.Position(lineNumber, startCharacter),
          new vscode.Position(lineNumber, startCharacter + name.length),
        ),
        name,
      });
    }
  }

  return [...candidates.values()];
}

function getIdentifierRange(
  document: vscode.TextDocument,
  position: vscode.Position,
): vscode.Range | undefined {
  return document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
}

function extendQualifiedConstUsageRange(
  document: vscode.TextDocument,
  symbolRange: vscode.Range,
): vscode.Range {
  const offsets = extendQualifiedConstUsageRangeOffsets(
    document.getText(),
    document.offsetAt(symbolRange.start),
    document.offsetAt(symbolRange.end),
  );

  return new vscode.Range(
    document.positionAt(offsets.startOffset),
    document.positionAt(offsets.endOffset),
  );
}

function findDeclarationStartLine(document: vscode.TextDocument, lineNumber: number): number {
  let startLine = lineNumber;

  while (startLine > 0) {
    const previousLine = document.lineAt(startLine - 1).text.trim();
    if (!previousLine || previousLine.startsWith('#') || /[;{}]$/.test(previousLine)) {
      break;
    }
    startLine -= 1;
  }

  return startLine;
}

function findStatementEndOffset(
  document: vscode.TextDocument,
  startLine: number,
): number | undefined {
  const text = document.getText();
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let inBlockComment = false;
  let inLineComment = false;
  let stringDelimiter: '"' | "'" | undefined;

  for (let index = document.offsetAt(new vscode.Position(startLine, 0)); index < text.length; index += 1) {
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

    if (current === ';' && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
      return index;
    }
  }

  return undefined;
}

function findNameOccurrenceAtOffset(
  text: string,
  symbolName: string,
  relativeOffset: number,
): { end: number; start: number } | undefined {
  const pattern = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`, 'g');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const start = match.index;
    const end = match.index + symbolName.length;
    if (relativeOffset >= start && relativeOffset <= end) {
      return { end, start };
    }
  }

  return undefined;
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

function findTopLevelCharacter(
  text: string,
  startIndex: number,
  character: string,
): number {
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
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

    if (
      current === character &&
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0
    ) {
      return index;
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

function containsTopLevelComma(text: string): boolean {
  return findTopLevelCharacter(text, 0, ',') >= 0;
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

function buildCommandUri(documentUri: vscode.Uri, position: vscode.Position): vscode.Uri {
  const payload = encodeURIComponent(
    JSON.stringify([
      {
        position: {
          character: position.character,
          line: position.line,
        },
        uri: documentUri.toString(),
      } satisfies ReplaceCommandArgs,
    ]),
  );

  return vscode.Uri.parse(`command:${COMMAND_REPLACE}?${payload}`);
}

function getClickBehavior(): 'disabled' | 'editorLink' | 'hoverLink' {
  const configuredValue = vscode.workspace
    .getConfiguration('constantsReplacement')
    .get<string>('clickBehavior', 'disabled');

  if (configuredValue === 'editorLink' || configuredValue === 'hoverLink') {
    return configuredValue;
  }

  return 'disabled';
}

function getParenthesizeExpressions(): boolean {
  return vscode.workspace
    .getConfiguration('constantsReplacement')
    .get<boolean>('parenthesizeExpressions', true);
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return SUPPORTED_LANGUAGE_IDS.has(document.languageId);
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeMarkdownCode(text: string): string {
  return text.replace(/`/g, '\\`');
}
