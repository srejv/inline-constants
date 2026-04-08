import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { downloadAndUnzipVSCode } from '@vscode/test-electron';

const TEST_VSCODE_VERSION = '1.114.0';
const WINDOWS_MUTEX_WARNING = 'Error: Error mutex already exists';

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../..');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');
    const testHostRoot = path.resolve(extensionDevelopmentPath, '.vscode-test-host');
    const cachePath = path.join(testHostRoot, 'cache');
    const runsRoot = path.join(testHostRoot, 'runs');

    fs.mkdirSync(testHostRoot, { recursive: true });
    fs.mkdirSync(runsRoot, { recursive: true });

    const runRoot = fs.mkdtempSync(path.join(runsRoot, 'session-'));
    const userDataDir = path.join(runRoot, 'user-data');
    const extensionsDir = path.join(runRoot, 'extensions');

    const vscodeExecutablePath = await downloadAndUnzipVSCode({
      cachePath,
      version: TEST_VSCODE_VERSION,
    });

    await runExtensionTests(vscodeExecutablePath, {
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionsDir,
      userDataDir,
    });
  } catch (error) {
    console.error('Failed to run extension tests.');
    if (error instanceof Error) {
      console.error(error);
    }
    process.exit(1);
  }
}

interface ExtensionTestLaunchOptions {
  extensionDevelopmentPath: string;
  extensionTestsPath: string;
  extensionsDir: string;
  userDataDir: string;
}

async function runExtensionTests(
  vscodeExecutablePath: string,
  options: ExtensionTestLaunchOptions,
): Promise<void> {
  const args = [
    options.extensionDevelopmentPath,
    '--disable-extensions',
    `--extensions-dir=${options.extensionsDir}`,
    `--user-data-dir=${options.userDataDir}`,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    `--extensionTestsPath=${options.extensionTestsPath}`,
    `--extensionDevelopmentPath=${options.extensionDevelopmentPath}`,
  ];

  const command = childProcess.spawn(vscodeExecutablePath, args, {
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  command.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
  });

  const stderrFilter = createStderrFilter(process.stderr);
  command.stderr?.on('data', (chunk: Buffer) => {
    stderrFilter.write(chunk.toString('utf8'));
  });

  await new Promise<void>((resolve, reject) => {
    const onSigint = () => {
      command.kill('SIGINT');
    };

    process.once('SIGINT', onSigint);

    command.on('error', (error) => {
      process.removeListener('SIGINT', onSigint);
      reject(error);
    });

    command.on('close', (code) => {
      process.removeListener('SIGINT', onSigint);
      stderrFilter.flush();

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`VS Code exited with code ${code ?? 'unknown'}.`));
    });
  });
}

function createStderrFilter(destination: NodeJS.WriteStream): {
  flush: () => void;
  write: (chunk: string) => void;
} {
  let buffer = '';
  let skipInstallMutexStackLine = false;

  const shouldFilterLine = (line: string): boolean => {
    const normalizedLine = line.replace(/\r?\n$/, '');

    if (process.platform === 'win32' && normalizedLine.includes(WINDOWS_MUTEX_WARNING)) {
      skipInstallMutexStackLine = true;
      return true;
    }

    if (skipInstallMutexStackLine) {
      skipInstallMutexStackLine = false;
      return /^\s+at hs\.installMutex/.test(normalizedLine);
    }

    return false;
  };

  const flushCompleteLines = (): void => {
    let newlineIndex = buffer.indexOf('\n');

    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex + 1);
      buffer = buffer.slice(newlineIndex + 1);

      if (!shouldFilterLine(line)) {
        destination.write(line);
      }

      newlineIndex = buffer.indexOf('\n');
    }
  };

  return {
    flush: () => {
      if (buffer.length > 0 && !shouldFilterLine(buffer)) {
        destination.write(buffer);
      }

      buffer = '';
    },
    write: (chunk: string) => {
      buffer += chunk;
      flushCompleteLines();
    },
  };
}

void main();
