import * as fs from 'node:fs';
import * as path from 'node:path';

import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../..');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const testHostRoot = path.resolve(extensionDevelopmentPath, '.vscode-test-host');
    const cachePath = path.join(testHostRoot, 'cache');
    const userDataDir = path.join(testHostRoot, 'user-data');
    const extensionsDir = path.join(testHostRoot, 'extensions');

    fs.rmSync(testHostRoot, { force: true, recursive: true });
    fs.mkdirSync(testHostRoot, { recursive: true });

    await runTests({
      cachePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        extensionDevelopmentPath,
        '--disable-extensions',
        `--extensions-dir=${extensionsDir}`,
        `--user-data-dir=${userDataDir}`,
      ],
      version: '1.114.0',
    });
  } catch (error) {
    console.error('Failed to run extension tests.');
    if (error instanceof Error) {
      console.error(error);
    }
    process.exit(1);
  }
}

void main();
