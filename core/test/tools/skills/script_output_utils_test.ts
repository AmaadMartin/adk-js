/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CodeExecutionResult, File, FileContentEncoding} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {materializeScriptOutputs} from '../../../src/tools/skill/script_output_utils.js';

/**
 * Environment variables `os.tmpdir()` consults, so a test can give the
 * implementation a temp root it exclusively owns and observe exactly what was
 * created in it. POSIX reads TMPDIR; Windows reads TEMP then TMP.
 */
const TMPDIR_ENV_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const;

function textFile(name: string, content: string): File {
  return {
    name,
    content,
    contentEncoding: FileContentEncoding.UTF8,
    mimeType: 'text/plain',
  };
}

function executionResult(outputFiles: File[]): CodeExecutionResult {
  return {stdout: 'out', stderr: 'err', outputFiles};
}

describe('materializeScriptOutputs', () => {
  let tmpRoot: string;
  let outputDir: string;
  let originalTmpdirEnv: Array<string | undefined>;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'script_output_test_'));
    // Real temp root is captured above, then redirected so the unconfigured
    // path writes somewhere this test can enumerate and delete.
    originalTmpdirEnv = TMPDIR_ENV_VARS.map((name) => process.env[name]);
    for (const name of TMPDIR_ENV_VARS) {
      process.env[name] = tmpRoot;
    }
    outputDir = await fs.mkdtemp(path.join(tmpRoot, 'configured_'));
  });

  afterEach(async () => {
    TMPDIR_ENV_VARS.forEach((name, index) => {
      const original = originalTmpdirEnv[index];
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    });
    await fs.rm(tmpRoot, {recursive: true, force: true});
  });

  it('writes output files into an explicit output directory', async () => {
    const result = await materializeScriptOutputs(
      executionResult([textFile('report.txt', 'contents')]),
      outputDir,
    );

    expect(result.outputDir).toBe(outputDir);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.outputFiles.map((file) => file.name)).toEqual(['report.txt']);
    expect(await fs.readFile(path.join(outputDir, 'report.txt'), 'utf8')).toBe(
      'contents',
    );
  });

  it('resolves a relative output directory against the working directory', async () => {
    // Working directory is moved to the temp root rather than deriving a
    // relative path from the real one: on Windows they sit on different
    // drives, where no relative path between them exists.
    const originalCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const relativeDir = path.basename(outputDir);
      expect(path.isAbsolute(relativeDir)).toBe(false);
      const expectedDir = path.resolve(process.cwd(), relativeDir);

      const result = await materializeScriptOutputs(
        executionResult([textFile('relative.txt', 'contents')]),
        relativeDir,
      );

      expect(result.outputDir).toBe(expectedDir);
      expect(
        await fs.readFile(path.join(expectedDir, 'relative.txt'), 'utf8'),
      ).toBe('contents');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('writes to a fresh temp directory when no output directory is configured', async () => {
    const name = 'unconfigured_default_output.txt';

    const result = await materializeScriptOutputs(
      executionResult([textFile(name, 'contents')]),
    );

    if (!result.outputDir) {
      expect.fail('expected an outputDir on the result');
    }
    expect(path.dirname(result.outputDir)).toBe(tmpRoot);
    expect(result.outputDir).not.toBe(process.cwd());
    expect(await fs.readFile(path.join(result.outputDir, name), 'utf8')).toBe(
      'contents',
    );
    await expect(fs.access(path.join(process.cwd(), name))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('creates a distinct directory per call', async () => {
    const first = await materializeScriptOutputs(
      executionResult([textFile('a.txt', 'first')]),
    );
    const second = await materializeScriptOutputs(
      executionResult([textFile('a.txt', 'second')]),
    );

    if (!first.outputDir || !second.outputDir) {
      expect.fail('expected an outputDir on both results');
    }
    expect(first.outputDir).not.toBe(second.outputDir);
    expect(await fs.readFile(path.join(first.outputDir, 'a.txt'), 'utf8')).toBe(
      'first',
    );
    expect(
      await fs.readFile(path.join(second.outputDir, 'a.txt'), 'utf8'),
    ).toBe('second');
  });

  it('returns the result unchanged and creates nothing when there are no output files', async () => {
    const before = await fs.readdir(tmpRoot);
    const input = executionResult([]);

    const result = await materializeScriptOutputs(input);

    expect(result).toBe(input);
    expect(result.outputDir).toBeUndefined();
    expect(await fs.readdir(tmpRoot)).toEqual(before);
  });

  it('rejects an output file that escapes the configured directory', async () => {
    await expect(
      materializeScriptOutputs(
        executionResult([textFile(path.join('..', 'escape.txt'), 'nope')]),
        outputDir,
      ),
    ).rejects.toThrow(/Path traversal detected/);

    await expect(
      fs.access(path.resolve(outputDir, '..', 'escape.txt')),
    ).rejects.toThrow(/ENOENT/);
  });

  it('appends a numeric suffix on collision within the configured directory', async () => {
    await fs.writeFile(path.join(outputDir, 'notes.txt'), 'existing');

    const result = await materializeScriptOutputs(
      executionResult([textFile('notes.txt', 'fresh')]),
      outputDir,
    );

    expect(result.outputFiles.map((file) => file.name)).toEqual([
      'notes_2.txt',
    ]);
    expect(await fs.readFile(path.join(outputDir, 'notes.txt'), 'utf8')).toBe(
      'existing',
    );
    expect(await fs.readFile(path.join(outputDir, 'notes_2.txt'), 'utf8')).toBe(
      'fresh',
    );
  });
});
