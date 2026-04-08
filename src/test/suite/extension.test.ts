import * as assert from 'node:assert/strict';

import * as vscode from 'vscode';

suite('Constants Replacement Extension', () => {
  const disposables: vscode.Disposable[] = [];

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('localdev.constants-replacement');
    assert.ok(extension, 'Expected extension to be available in the test host.');
    await extension.activate();

    disposables.push(
      vscode.languages.registerDefinitionProvider({ language: 'cpp' }, {
        provideDefinition(document, position) {
          const symbolRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
          if (!symbolRange) {
            return undefined;
          }

          const symbol = document.getText(symbolRange);
          const definitionRange = findDefinitionRange(document, symbol);
          if (!definitionRange) {
            return undefined;
          }

          return new vscode.Location(document.uri, definitionRange);
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
    await closeAllEditors();
  });

  test('replaces scope-qualified constexpr usage', async () => {
    const editor = await openCppEditor([
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
    await vscode.commands.executeCommand('constantsReplacement.replaceAtCursor');

    assert.match(editor.document.getText(), /return 20\.0f;/);
  });

  test('replaces const brace initializer usage', async () => {
    const editor = await openCppEditor([
      'const int basePadding{24};',
      '',
      'int render() {',
      '  return basePadding;',
      '}',
    ].join('\n'));

    setCursor(editor, 'basePadding', 1);
    await vscode.commands.executeCommand('constantsReplacement.replaceAtCursor');

    assert.match(editor.document.getText(), /return 24;/);
  });

  test('replaces const parenthesized initializer usage', async () => {
    const editor = await openCppEditor([
      'const float scaleFactor(1.5f);',
      '',
      'float render() {',
      '  return scaleFactor;',
      '}',
    ].join('\n'));

    setCursor(editor, 'scaleFactor', 1);
    await vscode.commands.executeCommand('constantsReplacement.replaceAtCursor');

    assert.match(editor.document.getText(), /return 1\.5f;/);
  });

  test('replaces function-like macro usage with expanded call-site arguments', async () => {
    const editor = await openCppEditor([
      '#define ADD_ONE(x) ((x) + 1)',
      '',
      'int render(int alpha, int beta) {',
      '  return ADD_ONE(alpha + beta);',
      '}',
    ].join('\n'));

    setCursor(editor, 'ADD_ONE', 1);
    await vscode.commands.executeCommand('constantsReplacement.replaceAtCursor');

    assert.match(editor.document.getText(), /return \(\(\(alpha \+ beta\)\) \+ 1\);/);
  });

  test('does not rewrite the original definition', async () => {
    const editor = await openCppEditor([
      'constexpr float emptyStateFontSize = 20.0f;',
      'float render() {',
      '  return emptyStateFontSize;',
      '}',
    ].join('\n'));

    setCursor(editor, 'emptyStateFontSize');
    const before = editor.document.getText();
    await vscode.commands.executeCommand('constantsReplacement.replaceAtCursor');

    assert.equal(editor.document.getText(), before);
  });

  test('does not offer replacement code actions on the definition itself', async () => {
    const editor = await openCppEditor([
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
    const editor = await openCppEditor([
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

    await vscode.commands.executeCommand('constantsReplacement.replaceAtCursor');
    assert.equal(editor.document.getText(), before);
  });
});

async function openCppEditor(content: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument({
    content,
    language: 'cpp',
  });

  return vscode.window.showTextDocument(document);
}

function setCursor(editor: vscode.TextEditor, symbol: string, occurrence = 0): void {
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
      new RegExp(`\\b(?:constexpr|const)\\b.*?\\b${escapeRegExp(symbol)}\\b\\s*(?:=|\\{|\\()`),
    );
    if (constMatch) {
      const startCharacter = line.indexOf(symbol);
      return new vscode.Range(lineNumber, startCharacter, lineNumber, startCharacter + symbol.length);
    }
  }

  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function closeAllEditors(): Promise<void> {
  while (vscode.window.activeTextEditor) {
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
}
