import * as assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

import * as vscode from 'vscode';

const SUPPORTED_LANGUAGE_IDS = ['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp'] as const;

suite('Inline Constants Extension', () => {
  const disposables: vscode.Disposable[] = [];

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('srejv.inline-constants');
    if (!extension) {
      throw new Error('Expected extension to be available in the test host.');
    }
    await extension.activate();

    disposables.push(
      vscode.languages.registerDefinitionProvider(SUPPORTED_LANGUAGE_IDS.map((language) => ({ language })), {
        provideDefinition(document, position) {
          const symbolRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
          if (!symbolRange) {
            return undefined;
          }

          const symbol = document.getText(symbolRange);
          const definitionLocation = findDefinitionLocation(document, symbol);
          if (!definitionLocation) {
            return undefined;
          }

          return definitionLocation;
        },
      }),
    );
  });

  suiteTeardown(() => {
    while (disposables.length > 0) {
      disposables.pop()?.dispose();
    }
  });

  teardown(async () => {
    await resetExtensionConfiguration();
    await closeAllEditors();
  });

  test('replaces scope-qualified constexpr usage', async () => {
    const editor = await openEditor([
      'namespace UiStyle {',
      'namespace Typography {',
      'constexpr float emptyStateFontSize = 20.0f;',
      '}',
      '}',
      '',
      'float render() {',
      '  return UiStyle::Typography::emptyStateFontSize;',
      '}',
    ].join('\n'));

    setCursor(editor, 'emptyStateFontSize', 1);
    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

    assert.match(editor.document.getText(), /return 20\.0f;/);
  });

  test('replaces const brace initializer usage', async () => {
    const editor = await openEditor([
      'const int basePadding{24};',
      '',
      'int render() {',
      '  return basePadding;',
      '}',
    ].join('\n'));

    setCursor(editor, 'basePadding', 1);
    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

    assert.match(editor.document.getText(), /return 24;/);
  });

  test('replaces const parenthesized initializer usage', async () => {
    const editor = await openEditor([
      'const float scaleFactor(1.5f);',
      '',
      'float render() {',
      '  return scaleFactor;',
      '}',
    ].join('\n'));

    setCursor(editor, 'scaleFactor', 1);
    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

    assert.match(editor.document.getText(), /return 1\.5f;/);
  });

  test('replaces object-like macro usage', async () => {
    const editor = await openEditor([
      '#define EMPTY_STATE_PADDING 24',
      '',
      'int render() {',
      '  return EMPTY_STATE_PADDING;',
      '}',
    ].join('\n'));

    setCursor(editor, 'EMPTY_STATE_PADDING', 1);
    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

    assert.match(editor.document.getText(), /return 24;/);
  });

  test('replaces multi-line object-like macro usage', async () => {
    const editor = await openEditor([
      '#define EMPTY_STATE_SCALE \\',
      '  (18.0f + 2.0f)',
      '',
      'float render() {',
      '  return EMPTY_STATE_SCALE;',
      '}',
    ].join('\n'));

    setCursor(editor, 'EMPTY_STATE_SCALE', 1);
    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

    assert.match(editor.document.getText(), /return \(18\.0f \+ 2\.0f\);/);
  });

  test('replaces multi-line function-like macro usage', async () => {
    const editor = await openEditor([
      '#define MIX_VALUES(x, y) \\',
      '  ((x) + \\',
      '  (y))',
      '',
      'int render(int left, int right) {',
      '  return MIX_VALUES(left + 1, right);',
      '}',
    ].join('\n'));

    setCursor(editor, 'MIX_VALUES', 1);
    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

    assert.match(editor.document.getText(), /return \(\(\(left \+ 1\)\) \+\s+\(\(right\)\)\);/);
  });

  test('replaces array-style constexpr usage with its initializer', async () => {
    const editor = await openEditor([
      'constexpr int values[] = {1, 2, 3};',
      '',
      'auto render() {',
      '  return values;',
      '}',
    ].join('\n'));

    setCursor(editor, 'values', 1);
    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

    assert.match(editor.document.getText(), /return \{1, 2, 3\};/);
  });

  test('replaces template-qualified constexpr direct initializer usage', async () => {
    const editor = await openEditor([
      'enum class ColorMode { Dark };',
      '',
      'template <ColorMode Mode>',
      'struct Theme;',
      '',
      'template <>',
      'struct Theme<ColorMode::Dark> {',
      '  struct Typography {',
      '    static constexpr float labelSize{18.0f};',
      '  };',
      '};',
      '',
      'float render() {',
      '  return Theme<ColorMode::Dark>::Typography::labelSize;',
      '}',
    ].join('\n'));

    setCursor(editor, 'labelSize', 1);
    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

    assert.match(editor.document.getText(), /return 18\.0f;/);
  });

  test('replaces cross-file constexpr usage resolved through the definition provider', async () => {
    const definitionEditor = await openEditor([
      'constexpr int sharedSpacing = 28;',
    ].join('\n'));
    const usageEditor = await openEditor([
      'int render() {',
      '  return sharedSpacing;',
      '}',
    ].join('\n'));

    setCursor(usageEditor, 'sharedSpacing');
    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

    assert.match(usageEditor.document.getText(), /return 28;/);
    assert.match(definitionEditor.document.getText(), /sharedSpacing = 28;/);
  });

  test('replaces nested template-qualified constexpr direct initializer usage', async () => {
    const editor = await openEditor([
      'enum class ColorMode { Dark };',
      '',
      'template <ColorMode Mode>',
      'struct Palette {};',
      '',
      'template <typename TPalette, int Variant>',
      'struct Theme {',
      '  struct Typography {',
      '    static constexpr float labelSize(21.0f);',
      '  };',
      '};',
      '',
      'float render() {',
      '  return Theme<Palette<ColorMode::Dark>, 4>::Typography::labelSize;',
      '}',
    ].join('\n'));

    setCursor(editor, 'labelSize', 1);
    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

    assert.match(editor.document.getText(), /return 21\.0f;/);
  });

  test('replaces function-like macro usage with expanded call-site arguments', async () => {
    const editor = await openEditor([
      '#define ADD_ONE(x) ((x) + 1)',
      '',
      'int render(int alpha, int beta) {',
      '  return ADD_ONE(alpha + beta);',
      '}',
    ].join('\n'));

    setCursor(editor, 'ADD_ONE', 1);
    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

    assert.match(editor.document.getText(), /return \(\(\(alpha \+ beta\)\) \+ 1\);/);
  });

  test('does not rewrite the original definition', async () => {
    const editor = await openEditor([
      'constexpr float emptyStateFontSize = 20.0f;',
      'float render() {',
      '  return emptyStateFontSize;',
      '}',
    ].join('\n'));

    setCursor(editor, 'emptyStateFontSize');
    const before = editor.document.getText();
    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

    assert.equal(editor.document.getText(), before);
  });

  test('does not offer replacement code actions on the definition itself', async () => {
    const editor = await openEditor([
      'constexpr float emptyStateFontSize = 20.0f;',
      'float render() {',
      '  return emptyStateFontSize;',
      '}',
    ].join('\n'));

    setCursor(editor, 'emptyStateFontSize');
    const actions = await getReplaceActions(editor);

    assert.equal(actions.length, 0);
  });

  test('does not offer replacement for unsupported variadic macros', async () => {
    const editor = await openEditor([
      '#define LOG_VALUE(fmt, ...) fmt',
      '',
      'const char* render(int value) {',
      '  return LOG_VALUE("%d", value);',
      '}',
    ].join('\n'));

    setCursor(editor, 'LOG_VALUE', 1);
    const before = editor.document.getText();
    const actions = await getReplaceActions(editor);

    assert.equal(actions.length, 0);

    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');
    assert.equal(editor.document.getText(), before);
  });

  test('does not offer replacement for stringizing macros', async () => {
    const editor = await openEditor([
      '#define TO_TEXT(value) #value',
      '',
      'const char* render() {',
      '  return TO_TEXT(emptyState);',
      '}',
    ].join('\n'));

    setCursor(editor, 'TO_TEXT', 1);
    const before = editor.document.getText();
    const actions = await getReplaceActions(editor);

    assert.equal(actions.length, 0);

    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');
    assert.equal(editor.document.getText(), before);
  });

  test('does not offer replacement for token-pasting macros', async () => {
    const editor = await openEditor([
      '#define MAKE_NAME(prefix, suffix) prefix ## suffix',
      '',
      'int render() {',
      '  return MAKE_NAME(emptyState, FontSize);',
      '}',
    ].join('\n'));

    setCursor(editor, 'MAKE_NAME', 1);
    const before = editor.document.getText();
    const actions = await getReplaceActions(editor);

    assert.equal(actions.length, 0);

    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');
    assert.equal(editor.document.getText(), before);
  });

  test('provides a hover replacement action when hoverLink is enabled', async () => {
    await setClickBehavior('hoverLink');

    const editor = await openEditor([
      'constexpr float emptyStateFontSize = 20.0f;',
      'float render() {',
      '  return emptyStateFontSize;',
      '}',
    ].join('\n'));

    const position = setCursor(editor, 'emptyStateFontSize', 1);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      editor.document.uri,
      position,
    );
    const hoverText = flattenHoverContents(hovers ?? []);

    assert.match(hoverText, /Inline emptyStateFontSize/);
    assert.match(hoverText, /Inlines to:/);
    assert.match(hoverText, /20\.0f/);
  });

  test('registers the replace command', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('inlineConstants.inlineAtCursor'));
  });

  test('offers a replace action on usage and not on whitespace', async () => {
    const editor = await openEditor([
      'constexpr int emptyStatePadding = 24;',
      'int render() {',
      '  return emptyStatePadding;',
      '}',
    ].join('\n'));

    setCursor(editor, 'emptyStatePadding', 1);
    const usageActions = await getReplaceActions(editor);
    assert.equal(usageActions.length, 1);

    const whitespacePosition = new vscode.Position(2, 2);
    editor.selection = new vscode.Selection(whitespacePosition, whitespacePosition);
    const whitespaceActions = await getReplaceActions(editor);
    assert.equal(whitespaceActions.length, 0);
  });

  test('does not apply replacement in unsupported languages', async function () {
    this.timeout(10000);

    const editor = await openEditor([
      'const emptyStatePadding = 24;',
      'function render() {',
      '  return emptyStatePadding;',
      '}',
    ].join('\n'), 'javascript');

    setCursor(editor, 'emptyStatePadding', 1);
    const before = editor.document.getText();

    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

    assert.equal(editor.document.getText(), before);
  });

  for (const languageId of ['c', 'cuda-cpp', 'objective-c', 'objective-cpp'] as const) {
    test(`replaces const usage in ${languageId}`, async () => {
      const editor = await openEditor([
        'const int emptyStatePadding = 24;',
        'int render(void) {',
        '  return emptyStatePadding;',
        '}',
      ].join('\n'), languageId);

      setCursor(editor, 'emptyStatePadding', 1);
      await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');

      assert.match(editor.document.getText(), /return 24;/);
    });
  }

  test('does not offer replacement for const declarations without an initializer', async () => {

    test('sets context availability true on usage and false on whitespace', async function () {
      this.timeout(10000);

      const editor = await openEditor([
        'constexpr int emptyStatePadding = 24;',
        'int render() {',
        '  return emptyStatePadding;',
        '}',
      ].join('\n'));

      setCursor(editor, 'emptyStatePadding', 1);
      await waitForCanReplaceContext(true);

      const whitespacePosition = new vscode.Position(2, 2);
      editor.selection = new vscode.Selection(whitespacePosition, whitespacePosition);
      await waitForCanReplaceContext(false);
    });

    test('sets context availability false on the definition site', async function () {
      this.timeout(10000);

      const editor = await openEditor([
        'constexpr int emptyStatePadding = 24;',
        'int render() {',
        '  return emptyStatePadding;',
        '}',
      ].join('\n'));

      setCursor(editor, 'emptyStatePadding');
      await waitForCanReplaceContext(false);

      setCursor(editor, 'emptyStatePadding', 1);
      await waitForCanReplaceContext(true);
    });
    const editor = await openEditor([
      'const int emptyStatePadding;',
      'int render() {',
      '  return emptyStatePadding;',
      '}',
    ].join('\n'));

    setCursor(editor, 'emptyStatePadding', 1);
    const before = editor.document.getText();
    const actions = await getReplaceActions(editor);

    assert.equal(actions.length, 0);

    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');
    assert.equal(editor.document.getText(), before);
  });

  test('does not offer replacement for malformed multi-value direct initializers', async () => {
    const editor = await openEditor([
      'constexpr float emptyStatePadding{20.0f, 24.0f};',
      'float render() {',
      '  return emptyStatePadding;',
      '}',
    ].join('\n'));

    setCursor(editor, 'emptyStatePadding', 1);
    const before = editor.document.getText();
    const actions = await getReplaceActions(editor);

    assert.equal(actions.length, 0);

    await vscode.commands.executeCommand('inlineConstants.inlineAtCursor');
    assert.equal(editor.document.getText(), before);
  });
});

async function openEditor(content: string, language = 'cpp'): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({
    content,
    language,
  });

  return vscode.window.showTextDocument(document);
}

function setCursor(editor: vscode.TextEditor, symbol: string, occurrence = 0): vscode.Position {
  const text = editor.document.getText();
  let searchFrom = 0;
  let symbolOffset = -1;

  for (let index = 0; index <= occurrence; index += 1) {
    symbolOffset = text.indexOf(symbol, searchFrom);
    if (symbolOffset < 0) {
      throw new Error(`Could not find occurrence ${occurrence} of symbol ${symbol}.`);
    }
    searchFrom = symbolOffset + symbol.length;
  }

  const position = editor.document.positionAt(symbolOffset + Math.floor(symbol.length / 2));
  editor.selection = new vscode.Selection(position, position);
  return position;
}

async function getReplaceActions(
  editor: vscode.TextEditor,
): Promise<(vscode.Command | vscode.CodeAction)[]> {
  return (await vscode.commands.executeCommand<(vscode.Command | vscode.CodeAction)[]>(
    'vscode.executeCodeActionProvider',
    editor.document.uri,
    editor.selection,
    vscode.CodeActionKind.RefactorInline.value,
  )) ?? [];
}

async function getCanReplaceContextValue(): Promise<boolean> {
  return await vscode.commands.executeCommand<boolean>('inlineConstants._getCanInlineAtCursorContext');
}

async function waitForCanReplaceContext(expected: boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if ((await getCanReplaceContextValue()) === expected) {
      return;
    }

    await delay(50);
  }

  assert.equal(await getCanReplaceContextValue(), expected);
}

function findDefinitionRange(document: vscode.TextDocument, symbol: string): vscode.Range | undefined {
  const lines = document.getText().split(/\r?\n/);

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    const macroMatch = line.match(new RegExp(`^\\s*#\\s*define\\s+${escapeRegExp(symbol)}\\b`));
    if (macroMatch) {
      const startCharacter = line.indexOf(symbol);
      return new vscode.Range(lineNumber, startCharacter, lineNumber, startCharacter + symbol.length);
    }

    const constMatch = line.match(
      new RegExp(`\\b(?:constexpr|const)\\b.*?\\b${escapeRegExp(symbol)}\\b(?:\\s*\\[[^\\]]*\\])*\\s*(?:=|\\{|\\()`),
    );
    if (constMatch) {
      const startCharacter = line.indexOf(symbol);
      return new vscode.Range(lineNumber, startCharacter, lineNumber, startCharacter + symbol.length);
    }
  }

  return undefined;
}

function findDefinitionLocation(
  sourceDocument: vscode.TextDocument,
  symbol: string,
): vscode.Location | undefined {
  const sameDocumentRange = findDefinitionRange(sourceDocument, symbol);
  if (sameDocumentRange) {
    return new vscode.Location(sourceDocument.uri, sameDocumentRange);
  }

  for (const document of vscode.workspace.textDocuments) {
    if (
      document.uri.toString() === sourceDocument.uri.toString() ||
      !SUPPORTED_LANGUAGE_IDS.includes(document.languageId as (typeof SUPPORTED_LANGUAGE_IDS)[number])
    ) {
      continue;
    }

    const definitionRange = findDefinitionRange(document, symbol);
    if (definitionRange) {
      return new vscode.Location(document.uri, definitionRange);
    }
  }

  return undefined;
}

async function setClickBehavior(value: 'disabled' | 'hoverLink'): Promise<void> {
  await vscode.workspace
    .getConfiguration('inlineConstants')
    .update('clickBehavior', value, vscode.ConfigurationTarget.Global);
}

async function resetExtensionConfiguration(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('inlineConstants');
  await configuration.update('clickBehavior', undefined, vscode.ConfigurationTarget.Global);
  await configuration.update('parenthesizeExpressions', undefined, vscode.ConfigurationTarget.Global);
}

function flattenHoverContents(hovers: readonly vscode.Hover[]): string {
  return hovers
    .flatMap((hover) => hover.contents)
    .map((content) => {
      if (content instanceof vscode.MarkdownString) {
        return content.value;
      }

      if (typeof content === 'string') {
        return content;
      }

      if ('value' in content) {
        return content.value;
      }

      return '';
    })
    .join('\n');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function closeAllEditors(): Promise<void> {
  while (vscode.window.activeTextEditor) {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
}
