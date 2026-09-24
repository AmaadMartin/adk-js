/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// These cases run against the real filesystem with no mocks, so the parsing and
// the validation under test are the ones the CLI actually performs.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {loadRunInputFile} from '../../src/cli/run_input_file.js';
import {createTempDir} from '../../src/utils/file_utils.js';

describe('loadRunInputFile', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await createTempDir('adk_run_input_file_test');
  });

  afterEach(async () => {
    await fs.rm(dir, {recursive: true, force: true});
  });

  async function writeInputFile(contents: string): Promise<string> {
    const filePath = path.join(dir, 'input.json');
    await fs.writeFile(filePath, contents, {encoding: 'utf-8'});
    return filePath;
  }

  it('returns the state and the queries of a valid file', async () => {
    const filePath = await writeInputFile(
      JSON.stringify({state: {city: 'Paris'}, queries: ['hi', 'bye']}),
    );

    const inputFile = await loadRunInputFile(filePath);

    expect(inputFile.state).toEqual({city: 'Paris'});
    expect(inputFile.queries).toEqual(['hi', 'bye']);
  });

  it('accepts an empty state and an empty query list', async () => {
    const filePath = await writeInputFile(
      JSON.stringify({state: {}, queries: []}),
    );

    const inputFile = await loadRunInputFile(filePath);

    expect(inputFile).toEqual({state: {}, queries: []});
  });

  it('rejects a file whose queries field is missing', async () => {
    const filePath = await writeInputFile(
      JSON.stringify({state: {}, query: 'hi'}),
    );

    await expect(loadRunInputFile(filePath)).rejects.toThrow(
      `Invalid run input file ${filePath}: queries: Invalid input: expected array, received undefined`,
    );
  });

  it('rejects a file whose queries hold a value that is not a string', async () => {
    const filePath = await writeInputFile(
      JSON.stringify({state: {}, queries: ['hi', 7]}),
    );

    await expect(loadRunInputFile(filePath)).rejects.toThrow(
      `Invalid run input file ${filePath}: queries.1: Invalid input: expected string, received number`,
    );
  });

  it('rejects a file whose state field is missing', async () => {
    const filePath = await writeInputFile(JSON.stringify({queries: ['hi']}));

    await expect(loadRunInputFile(filePath)).rejects.toThrow(
      `Invalid run input file ${filePath}: state: Invalid input: expected record, received undefined`,
    );
  });

  it('names every failing field when more than one is wrong', async () => {
    const filePath = await writeInputFile(JSON.stringify({}));

    await expect(loadRunInputFile(filePath)).rejects.toThrow(
      /state: .*; queries: /,
    );
  });

  it('rejects a document that is not an object', async () => {
    const filePath = await writeInputFile(JSON.stringify(['hi']));

    await expect(loadRunInputFile(filePath)).rejects.toThrow(
      `Invalid run input file ${filePath}: Invalid input: expected object, received array`,
    );
  });

  it('rejects malformed JSON', async () => {
    const filePath = await writeInputFile('{"state": {}, "queries": [');

    await expect(loadRunInputFile(filePath)).rejects.toThrow(
      `Failed to read or parse file ${filePath}`,
    );
  });

  it('rejects a file that does not exist', async () => {
    const filePath = path.join(dir, 'absent.json');

    await expect(loadRunInputFile(filePath)).rejects.toThrow(
      `Failed to read or parse file ${filePath}`,
    );
  });
});
