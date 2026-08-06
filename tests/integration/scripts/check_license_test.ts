/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawnSync, type SpawnSyncReturns} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'check_license.sh');

const LICENSE_HEADER = `/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
`;

/**
 * Stands in for `find` on PATH: it prints one NUL-terminated path, writes a
 * diagnostic to stderr and exits non-zero, which is what a real `find` does
 * when it aborts partway through a scan.
 */
const FAILING_FIND_STUB = `#!/bin/bash
printf './ok.ts\\0'
echo "find: ./denied: Permission denied" >&2
exit 1
`;

function runScript(cwd: string, pathPrefix?: string): SpawnSyncReturns<string> {
  return spawnSync('bash', [SCRIPT_PATH], {
    cwd,
    encoding: 'utf8',
    env: pathPrefix
      ? {
          ...process.env,
          PATH: `${pathPrefix}${path.delimiter}${process.env.PATH}`,
        }
      : process.env,
  });
}

describe.skipIf(process.platform === 'win32')('check_license.sh', () => {
  let scratchDir = '';

  beforeEach(async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-license-check-'));
  });

  afterEach(async () => {
    await fs.rm(scratchDir, {recursive: true, force: true});
  });

  it('passes when every file has a valid header', async () => {
    await fs.writeFile(path.join(scratchDir, 'ok.ts'), LICENSE_HEADER);

    const result = runScript(scratchDir);

    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      '✅ All files have the correct license header.',
    );
    expect(result.status).toBe(0);
  });

  it('fails and names the file when a header is missing', async () => {
    await fs.writeFile(
      path.join(scratchDir, 'bad.ts'),
      'export const x = 1;\n',
    );

    const result = runScript(scratchDir);

    expect(result.stdout).toContain(
      '❌ Missing or invalid license header: ./bad.ts',
    );
    expect(result.stdout).toContain(
      'Error: Some files are missing the required license header.',
    );
    expect(result.status).toBe(1);
  });

  it('fails when the search matches no .js or .ts file', async () => {
    await fs.writeFile(path.join(scratchDir, 'README.md'), '# no sources\n');

    const result = runScript(scratchDir);

    expect(result.stderr).toContain('no .js or .ts files were found');
    expect(result.stdout).not.toContain('✅');
    expect(result.status).toBe(1);
  });

  it('checks a file whose directory name contains a space', async () => {
    await fs.writeFile(path.join(scratchDir, 'ok.ts'), LICENSE_HEADER);
    await fs.mkdir(path.join(scratchDir, 'a b'));
    await fs.writeFile(
      path.join(scratchDir, 'a b', 'bad.ts'),
      'export const y = 2;\n',
    );

    const result = runScript(scratchDir);

    expect(result.stdout).toContain(
      '❌ Missing or invalid license header: ./a b/bad.ts',
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("Can't open");
    expect(result.status).toBe(1);
  });

  it('fails when find exits non-zero after printing a path', async () => {
    await fs.writeFile(path.join(scratchDir, 'ok.ts'), LICENSE_HEADER);
    const stubDir = path.join(scratchDir, 'bin');
    await fs.mkdir(stubDir);
    const stubPath = path.join(stubDir, 'find');
    await fs.writeFile(stubPath, FAILING_FIND_STUB);
    await fs.chmod(stubPath, 0o755);

    const result = runScript(scratchDir, stubDir);

    expect(result.stderr).toContain('failed to list source files');
    expect(result.stdout).not.toContain('✅');
    expect(result.status).toBe(1);
  });
});
