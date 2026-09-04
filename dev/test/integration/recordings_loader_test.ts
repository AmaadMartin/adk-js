/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  loadRecordings,
  recordingsFilePath,
} from '../../src/integration/recordings_loader.js';
import {isReplayConfigError} from '../../src/integration/replay_errors.js';
import {
  createCaseDir,
  NON_STREAMING_FILE,
  removeCase,
  STREAMING_FILE,
  toolRecordingFixture,
  writeRecordings,
} from './replay_test_support.js';

describe('recordingsFilePath', () => {
  it('names the plain file for the non-streaming mode', () => {
    expect(recordingsFilePath('/cases/dice', 'none')).toBe(
      path.join('/cases/dice', NON_STREAMING_FILE),
    );
  });

  it('names the sse file for the streaming mode', () => {
    expect(recordingsFilePath('/cases/dice', 'sse')).toBe(
      path.join('/cases/dice', STREAMING_FILE),
    );
  });

  it('rejects a streaming mode it has no file for', () => {
    expect(() => recordingsFilePath('/cases/dice', 'bidi')).toThrow(
      'Unsupported streaming mode: bidi',
    );
  });
});

describe('loadRecordings', () => {
  let caseDir: string;

  beforeEach(async () => {
    caseDir = await createCaseDir();
  });

  afterEach(async () => {
    await removeCase(caseDir);
  });

  it('converts the schema keys to camelCase', async () => {
    await writeRecordings(caseDir, [
      toolRecordingFixture({agentName: 'agent_a', userMessageIndex: 2}),
    ]);

    const {recordings} = await loadRecordings(
      path.join(caseDir, NON_STREAMING_FILE),
    );

    expect(recordings).toHaveLength(1);
    expect(recordings[0].userMessageIndex).toBe(2);
    expect(recordings[0].agentName).toBe('agent_a');
    expect(recordings[0].toolRecording?.toolCall?.name).toBe('roll_die');
  });

  it('leaves a recorded argument name untouched', async () => {
    await writeRecordings(caseDir, [
      toolRecordingFixture({
        args: {user_name: 'ada'},
        response: {greeting_text: 'hi ada'},
      }),
    ]);

    const {recordings} = await loadRecordings(
      path.join(caseDir, NON_STREAMING_FILE),
    );

    expect(recordings[0].toolRecording?.toolCall?.args).toEqual({
      user_name: 'ada',
    });
    expect(recordings[0].toolRecording?.toolResponse?.response).toEqual({
      greeting_text: 'hi ada',
    });
  });

  it('accepts the llm_responses list adk-python records', async () => {
    await fs.writeFile(
      path.join(caseDir, NON_STREAMING_FILE),
      'recordings:\n  - user_message_index: 0\n    agent_name: agent_a\n' +
        '    llm_recording:\n      llm_responses:\n        - partial: false\n',
      'utf-8',
    );

    const {recordings} = await loadRecordings(
      path.join(caseDir, NON_STREAMING_FILE),
    );

    expect(recordings).toHaveLength(1);
    expect(recordings[0].llmRecording).toBeDefined();
  });

  it('rejects an unknown key on a recording', async () => {
    await fs.writeFile(
      path.join(caseDir, NON_STREAMING_FILE),
      'recordings:\n  - user_message_index: 0\n    agent_name: a\n' +
        '    tool_recordings: {}\n',
      'utf-8',
    );

    const error = await loadRecordings(
      path.join(caseDir, NON_STREAMING_FILE),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    if (!(error instanceof Error)) {
      expect.fail('loadRecordings resolved instead of throwing');
    }
    expect(isReplayConfigError(error)).toBe(true);
    expect(error.message).toContain('Failed to load recordings');
  });

  it('reports a missing file with its path', async () => {
    const missing = path.join(caseDir, NON_STREAMING_FILE);

    const error = await loadRecordings(missing).then(
      () => undefined,
      (e: unknown) => e,
    );

    if (!(error instanceof Error)) {
      expect.fail('loadRecordings resolved instead of throwing');
    }
    expect(isReplayConfigError(error)).toBe(true);
    expect(error.message).toBe(`Recordings file not found: ${missing}`);
  });

  it('reports a read failure that is not a missing file', async () => {
    const error = await loadRecordings(caseDir).then(
      () => undefined,
      (e: unknown) => e,
    );

    if (!(error instanceof Error)) {
      expect.fail('loadRecordings resolved instead of throwing');
    }
    expect(isReplayConfigError(error)).toBe(true);
    expect(error.message).toContain('Failed to load recordings');
    expect(error.message).not.toContain('not found');
  });

  it('rejects a file that is not a YAML mapping', async () => {
    await fs.writeFile(
      path.join(caseDir, NON_STREAMING_FILE),
      '- just a list\n',
      'utf-8',
    );

    const error = await loadRecordings(
      path.join(caseDir, NON_STREAMING_FILE),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    if (!(error instanceof Error)) {
      expect.fail('loadRecordings resolved instead of throwing');
    }
    expect(isReplayConfigError(error)).toBe(true);
    expect(error.message).toContain('not a YAML mapping');
  });

  it('leaves the arguments of a recorded function call untouched', async () => {
    await fs.writeFile(
      path.join(caseDir, NON_STREAMING_FILE),
      'recordings:\n  - user_message_index: 0\n    agent_name: agent_a\n' +
        '    llm_recording:\n      llm_response:\n        content:\n' +
        '          parts:\n            - function_call:\n' +
        '                name: greet\n                args:\n' +
        '                  user_name: ada\n',
      'utf-8',
    );

    const {recordings} = await loadRecordings(
      path.join(caseDir, NON_STREAMING_FILE),
    );

    // The schema keys convert, so `function_call` is readable as `functionCall`
    // while the arguments the agent chose keep the names it recorded.
    expect(
      recordings[0].llmRecording?.llmResponse?.content?.parts?.[0]
        ?.functionCall,
    ).toEqual({name: 'greet', args: {user_name: 'ada'}});
  });

  it('defaults to no recordings when the file holds an empty mapping', async () => {
    await fs.writeFile(path.join(caseDir, NON_STREAMING_FILE), '{}\n', 'utf-8');

    const {recordings} = await loadRecordings(
      path.join(caseDir, NON_STREAMING_FILE),
    );

    expect(recordings).toEqual([]);
  });

  it('keeps a scalar inside a recorded argument as it was written', async () => {
    await writeRecordings(caseDir, [
      toolRecordingFixture({args: {nested_list: [{inner_key: 1}]}}),
    ]);

    const {recordings} = await loadRecordings(
      path.join(caseDir, NON_STREAMING_FILE),
    );

    expect(recordings[0].toolRecording?.toolCall?.args).toEqual({
      nested_list: [{inner_key: 1}],
    });
  });
});
