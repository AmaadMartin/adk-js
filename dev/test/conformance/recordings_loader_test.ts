/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {loadRecordings} from '../../src/conformance/recordings_loader.js';
import {ReplayConfigError} from '../../src/integration/replay_errors.js';

const NON_STREAMING_FILE = 'generated-recordings.yaml';
const STREAMING_FILE = 'generated-recordings-sse.yaml';

/** Returns the error `call` rejected with, failing the test if it resolved. */
async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (e: unknown) {
    return e;
  }
  return expect.fail('the call resolved instead of rejecting');
}

describe('loadRecordings', () => {
  let caseDir: string;

  beforeEach(async () => {
    caseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-recordings-'));
  });

  afterEach(async () => {
    await fs.rm(caseDir, {recursive: true, force: true});
  });

  async function write(fileName: string, body: string): Promise<void> {
    await fs.writeFile(path.join(caseDir, fileName), body, 'utf-8');
  }

  it('should keep a snake_case tool argument name unchanged', async () => {
    await write(
      NON_STREAMING_FILE,
      `recordings:
  - user_message_index: 0
    agent_name: agent_a
    tool_recording:
      tool_call:
        name: greet
        args:
          user_name: ada
      tool_response:
        name: greet
        response:
          greeting_text: hello
`,
    );

    const {recordings} = await loadRecordings(caseDir, 'none');

    expect(recordings[0].toolRecording?.toolCall?.args).toEqual({
      user_name: 'ada',
    });
    expect(recordings[0].toolRecording?.toolResponse?.response).toEqual({
      greeting_text: 'hello',
    });
  });

  it('should camelize the recording envelope', async () => {
    await write(
      NON_STREAMING_FILE,
      'recordings:\n  - user_message_index: 3\n    agent_name: agent_a\n',
    );

    const {recordings} = await loadRecordings(caseDir, 'none');

    expect(recordings[0].userMessageIndex).toBe(3);
    expect(recordings[0].agentName).toBe('agent_a');
  });

  it('should read the sse file in sse mode and the plain file in none mode', async () => {
    await write(
      NON_STREAMING_FILE,
      'recordings:\n  - user_message_index: 0\n    agent_name: plain\n',
    );
    await write(
      STREAMING_FILE,
      'recordings:\n  - user_message_index: 0\n    agent_name: streamed\n',
    );

    const plain = await loadRecordings(caseDir, 'none');
    const streamed = await loadRecordings(caseDir, 'sse');

    expect(plain.recordings[0].agentName).toBe('plain');
    expect(streamed.recordings[0].agentName).toBe('streamed');
  });

  it('should reject an unsupported streaming mode', async () => {
    const error = await rejection(loadRecordings(caseDir, 'bidi'));

    expect(error).not.toBeInstanceOf(ReplayConfigError);
    expect(error).toHaveProperty('message', 'Unsupported streaming mode: bidi');
  });

  it('should report the path of a missing recordings file', async () => {
    const error = await rejection(loadRecordings(caseDir, 'none'));

    expect(error).toBeInstanceOf(ReplayConfigError);
    expect(error).toHaveProperty(
      'message',
      `Recordings file not found: ${path.join(caseDir, NON_STREAMING_FILE)}`,
    );
  });

  it('should reject an unknown key in the recording envelope', async () => {
    await write(
      NON_STREAMING_FILE,
      'recordings:\n  - user_message_index: 0\n    agent_name: a\n' +
        '    tool_recordings: {}\n',
    );

    const error = await rejection(loadRecordings(caseDir, 'none'));

    expect(error).toBeInstanceOf(ReplayConfigError);
    expect(String(error)).toContain('Failed to load recordings');
    expect(String(error)).toContain('toolRecordings');
  });

  it('should reject a document that is not a mapping', async () => {
    await write(NON_STREAMING_FILE, 'just a string\n');

    const error = await rejection(loadRecordings(caseDir, 'none'));

    expect(error).toBeInstanceOf(ReplayConfigError);
    expect(String(error)).toContain('Recordings file must be a YAML mapping');
  });

  it('should carry the original failure as the cause', async () => {
    await write(NON_STREAMING_FILE, 'recordings: not-a-list\n');

    const error = await rejection(loadRecordings(caseDir, 'none'));

    expect(error).toBeInstanceOf(ReplayConfigError);
    expect(error).toHaveProperty('cause', expect.any(Error));
  });
});
