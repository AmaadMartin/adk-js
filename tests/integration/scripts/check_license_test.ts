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

const HEADER = `/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
`;

/** The two-space variant the esbuild `banner` option emits. */
const INDENTED_HEADER = HEADER.replace(/^ \*/gm, '  *');

const PASS_MESSAGE = '✅ All files have the correct license header.';
const PLACEMENT_MESSAGE = 'The header must be the first thing in the file';

describe.skipIf(os.platform() === 'win32')('check_license.sh', () => {
  let scratchDir = '';

  beforeEach(async () => {
    scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-license-check-'));
  });

  afterEach(async () => {
    await fs.rm(scratchDir, {recursive: true, force: true});
  });

  async function writeFixture(name: string, contents: string): Promise<void> {
    await fs.writeFile(path.join(scratchDir, name), contents);
  }

  function runScript(): SpawnSyncReturns<string> {
    return spawnSync('bash', [SCRIPT_PATH], {
      cwd: scratchDir,
      encoding: 'utf8',
    });
  }

  it('passes when the header is the first thing in the file', async () => {
    await writeFixture('ok.ts', `${HEADER}export const x = 1;\n`);

    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(PASS_MESSAGE);
  });

  it('fails when a file has no header', async () => {
    await writeFixture('none.ts', 'export const x = 1;\n');

    const result = runScript();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      '❌ Missing or invalid license header: ./none.ts',
    );
  });

  it('fails when a malformed header precedes a valid one', async () => {
    await writeFixture(
      'artifact.js',
      `${INDENTED_HEADER}const x = 1;\n${HEADER}`,
    );

    const result = runScript();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      '❌ Missing or invalid license header: ./artifact.js',
    );
    expect(result.stdout).toContain(PLACEMENT_MESSAGE);
  });

  it('allows a shebang above the header', async () => {
    await writeFixture('cli.ts', `#! /usr/bin/env node\n${HEADER}`);

    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(PASS_MESSAGE);
  });

  it('allows a single-line block comment above the header', async () => {
    await writeFixture('sketch.js', `/* eslint-disable */\n${HEADER}`);

    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(PASS_MESSAGE);
  });
});
