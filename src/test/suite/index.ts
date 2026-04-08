import * as path from 'node:path';
import * as fs from 'node:fs';

import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({
    color: true,
    ui: 'tdd',
  });

  const testsRoot = __dirname;

  return new Promise((resolve, reject) => {
    fs.readdirSync(testsRoot)
      .filter((file) => file.endsWith('.test.js'))
      .forEach((file) => {
        mocha.addFile(path.resolve(testsRoot, file));
      });

    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} extension test(s) failed.`));
        return;
      }

      resolve();
    });
  });
}
