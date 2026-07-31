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
import {materializeSkillOutputFiles} from '../../../src/tools/skill/skill_output_files.js';

describe('materializeSkillOutputFiles', () => {
  /** Every directory the test or the module under test created. */
  let dirsToRemove: string[];
  let scratchDir: string;

  beforeEach(async () => {
    scratchDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'skill_output_files_test_'),
    );
    dirsToRemove = [scratchDir];
  });

  afterEach(async () => {
    await Promise.all(
      dirsToRemove.map((dir) => fs.rm(dir, {recursive: true, force: true})),
    );
  });

  function file(name: string, content = 'hello'): File {
    return {
      name,
      content,
      contentEncoding: FileContentEncoding.UTF8,
      mimeType: 'text/plain',
    };
  }

  function executionResult(...files: File[]): CodeExecutionResult {
    return {stdout: 'out', stderr: 'err', outputFiles: files};
  }

  /**
   * Returns `result.outputDir`, registering it for cleanup. Fails the test when
   * the module did not report one, which also narrows the type for the caller.
   */
  function takeOutputDir(result: {outputDir?: string}): string {
    if (result.outputDir === undefined) {
      return expect.fail('expected the result to report an outputDir');
    }
    dirsToRemove.push(result.outputDir);
    return result.outputDir;
  }

  async function exists(filePath: string): Promise<boolean> {
    return fs
      .access(filePath)
      .then(() => true)
      .catch(() => false);
  }

  it('writes into a fresh temp directory when none is declared', async () => {
    const result = await materializeSkillOutputFiles(
      executionResult(file('report.txt')),
    );

    const outputDir = takeOutputDir(result);
    expect(path.isAbsolute(outputDir)).toBe(true);
    expect(path.dirname(outputDir)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(outputDir).startsWith('adk-skill-output-')).toBe(true);
    expect(await exists(path.join(outputDir, 'report.txt'))).toBe(true);
  });

  it('does not write script-named files into the process working directory', async () => {
    const scriptChosenName = `cwd_regression_${process.pid}.txt`;

    const result = await materializeSkillOutputFiles(
      executionResult(file(scriptChosenName)),
    );

    const outputDir = takeOutputDir(result);
    expect(outputDir).not.toBe(process.cwd());
    expect(await exists(path.join(process.cwd(), scriptChosenName))).toBe(
      false,
    );
  });

  it('gives each undeclared call its own directory', async () => {
    const first = await materializeSkillOutputFiles(
      executionResult(file('report.txt', 'first')),
    );
    const second = await materializeSkillOutputFiles(
      executionResult(file('report.txt', 'second')),
    );

    const firstDir = takeOutputDir(first);
    const secondDir = takeOutputDir(second);
    expect(firstDir).not.toBe(secondDir);
    // Separate directories mean no collision rename between the two calls.
    expect(first.outputFiles[0].name).toBe('report.txt');
    expect(second.outputFiles[0].name).toBe('report.txt');
    expect(await fs.readFile(path.join(firstDir, 'report.txt'), 'utf8')).toBe(
      'first',
    );
    expect(await fs.readFile(path.join(secondDir, 'report.txt'), 'utf8')).toBe(
      'second',
    );
  });

  it('reports names relative to the output directory, including nested ones', async () => {
    const result = await materializeSkillOutputFiles(
      executionResult(file('report.txt', 'top'), file('sub/out.txt', 'nested')),
    );

    const outputDir = takeOutputDir(result);
    expect(result.outputFiles.map((f) => f.name)).toEqual([
      'report.txt',
      path.join('sub', 'out.txt'),
    ]);
    for (const outputFile of result.outputFiles) {
      expect(path.isAbsolute(outputFile.name)).toBe(false);
    }
    expect(await fs.readFile(path.join(outputDir, 'report.txt'), 'utf8')).toBe(
      'top',
    );
    expect(
      await fs.readFile(path.join(outputDir, 'sub', 'out.txt'), 'utf8'),
    ).toBe('nested');
  });

  it('uses a declared directory verbatim and creates it recursively', async () => {
    const declaredDir = path.join(scratchDir, 'declared', 'nested');

    const result = await materializeSkillOutputFiles(
      executionResult(file('report.txt')),
      declaredDir,
    );

    expect(result.outputDir).toBe(path.resolve(declaredDir));
    expect(await exists(path.join(declaredDir, 'report.txt'))).toBe(true);
  });

  it('renames a colliding file inside a declared directory', async () => {
    const declaredDir = path.join(scratchDir, 'declared');
    await fs.mkdir(declaredDir, {recursive: true});
    await fs.writeFile(path.join(declaredDir, 'report.txt'), 'pre-existing');

    const result = await materializeSkillOutputFiles(
      executionResult(file('report.txt', 'from script')),
      declaredDir,
    );

    expect(result.outputFiles[0].name).toBe('report_2.txt');
    expect(
      await fs.readFile(path.join(declaredDir, 'report.txt'), 'utf8'),
    ).toBe('pre-existing');
    expect(
      await fs.readFile(path.join(declaredDir, 'report_2.txt'), 'utf8'),
    ).toBe('from script');
  });

  it('returns the result untouched and creates nothing when there are no output files', async () => {
    const empty = executionResult();
    const declaredDir = path.join(scratchDir, 'never-created');

    const undeclared = await materializeSkillOutputFiles(empty);
    const declared = await materializeSkillOutputFiles(empty, declaredDir);

    expect(undeclared).toBe(empty);
    expect(declared).toBe(empty);
    expect('outputDir' in undeclared).toBe(false);
    expect('outputDir' in declared).toBe(false);
    expect(await exists(declaredDir)).toBe(false);
  });

  it('rejects a name that escapes the output directory without writing outside it', async () => {
    const declaredDir = path.join(scratchDir, 'declared');

    await expect(
      materializeSkillOutputFiles(
        executionResult(file('../escape.txt')),
        declaredDir,
      ),
    ).rejects.toThrow(/escape\.txt/);

    expect(await exists(path.join(scratchDir, 'escape.txt'))).toBe(false);
  });
});
