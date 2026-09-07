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

import {
  loadRunInputFile,
  loadSavedSession,
} from '../../src/cli/run_input_file.js';
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

describe('loadSavedSession', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await createTempDir('adk_saved_session_test');
  });

  afterEach(async () => {
    await fs.rm(dir, {recursive: true, force: true});
  });

  async function writeSessionFile(contents: string): Promise<string> {
    const filePath = path.join(dir, 'session.json');
    await fs.writeFile(filePath, contents, {encoding: 'utf-8'});
    return filePath;
  }

  it('returns the state and the events of a saved session', async () => {
    const filePath = await writeSessionFile(
      JSON.stringify({
        state: {city: 'Paris'},
        events: [{author: 'user', content: {parts: [{text: 'hi'}]}}],
      }),
    );

    const saved = await loadSavedSession(filePath);

    expect(saved.state).toEqual({city: 'Paris'});
    expect(saved.events).toEqual([
      {author: 'user', content: {parts: [{text: 'hi'}]}},
    ]);
  });

  it('accepts the document --save_session writes', async () => {
    const filePath = await writeSessionFile(
      JSON.stringify({
        id: 'old-session',
        appName: 'test-agent',
        userId: 'test_user',
        state: {},
        events: [{author: 'model'}],
        lastUpdateTime: 1700000000,
      }),
    );

    const saved = await loadSavedSession(filePath);

    expect(saved.events).toEqual([{author: 'model'}]);
  });

  it('defaults the state and the events a document omits', async () => {
    const filePath = await writeSessionFile(JSON.stringify({id: 'only-an-id'}));

    const saved = await loadSavedSession(filePath);

    expect(saved).toEqual({state: {}, events: []});
  });

  it('rejects a document whose events field is not an array', async () => {
    const filePath = await writeSessionFile(JSON.stringify({events: 'hi'}));

    await expect(loadSavedSession(filePath)).rejects.toThrow(
      `Invalid saved session file ${filePath}: events: Invalid input: expected array, received string`,
    );
  });

  it('rejects a document whose events hold a value that is not an object', async () => {
    const filePath = await writeSessionFile(
      JSON.stringify({events: [{author: 'user'}, 'hi']}),
    );

    await expect(loadSavedSession(filePath)).rejects.toThrow(
      `Invalid saved session file ${filePath}: events.1: expected an event object`,
    );
  });

  it('rejects a document whose state field is not an object', async () => {
    const filePath = await writeSessionFile(JSON.stringify({state: 'hi'}));

    await expect(loadSavedSession(filePath)).rejects.toThrow(
      `Invalid saved session file ${filePath}: state: Invalid input: expected record, received string`,
    );
  });

  it('names every failing field when more than one is wrong', async () => {
    const filePath = await writeSessionFile(
      JSON.stringify({state: 7, events: 7}),
    );

    await expect(loadSavedSession(filePath)).rejects.toThrow(
      /state: .*; events: /,
    );
  });

  it('rejects a document that is not an object', async () => {
    const filePath = await writeSessionFile(JSON.stringify(null));

    await expect(loadSavedSession(filePath)).rejects.toThrow(
      `Invalid saved session file ${filePath}: Invalid input: expected object, received null`,
    );
  });

  it('rejects a file that does not exist', async () => {
    const filePath = path.join(dir, 'absent.json');

    await expect(loadSavedSession(filePath)).rejects.toThrow(
      `Failed to read or parse file ${filePath}`,
    );
  });
});
