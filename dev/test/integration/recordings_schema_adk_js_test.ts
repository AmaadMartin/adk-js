/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import camelcaseKeys from 'camelcase-keys';
import yaml from 'js-yaml';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  LlmRecordingSchema,
  RecordingSchema,
  RecordingsSchema,
} from '../../src/integration/recordings_schema.js';

const RECORDINGS_YAML = `
recordings:
  - user_message_index: 0
    agent_name: dice_agent
    tool_recording:
      tool_call:
        name: roll_die
      tool_response:
        response:
          result: 4
`;

const TYPO_RECORDINGS_YAML = `
recordings:
  - user_message_index: 0
    agent_name: dice_agent
    tool_recordings:
      tool_call:
        name: roll_die
`;

/** Reproduces what batchLoadYamlTestDefs does to a recordings file. */
function loadRecordings(source: string) {
  const parsed = yaml.load(source);
  if (typeof parsed !== 'object' || parsed === null) {
    expect.fail('the fixture must be a YAML mapping');
  }
  return RecordingsSchema.parse(camelcaseKeys(parsed, {deep: true}));
}

describe('recordings schema on the loader path', () => {
  it('accepts a snake_case recordings file after camelization', () => {
    const recordings = loadRecordings(RECORDINGS_YAML);

    expect(recordings.recordings).toHaveLength(1);
    expect(recordings.recordings[0].userMessageIndex).toBe(0);
    expect(recordings.recordings[0].toolRecording?.toolCall?.name).toBe(
      'roll_die',
    );
  });

  it('rejects a snake_case typo and names the camelized key', () => {
    expect(() => loadRecordings(TYPO_RECORDINGS_YAML)).toThrow(z.ZodError);
    expect(() => loadRecordings(TYPO_RECORDINGS_YAML)).toThrow(
      'toolRecordings',
    );
  });

  it('reads an empty document as an empty recordings list', () => {
    expect(RecordingsSchema.parse({})).toEqual({recordings: []});
  });
});

describe('recordings schema field rules', () => {
  it('carries the adk-js singular response and the adk-python list together', () => {
    const parsed = LlmRecordingSchema.parse({
      llmResponse: {content: {role: 'model', parts: [{text: 'one'}]}},
      llmResponses: [{content: {role: 'model', parts: [{text: 'two'}]}}],
    });

    expect(parsed.llmResponse?.content?.parts?.[0]?.text).toBe('one');
    expect(parsed.llmResponses?.[0]?.content?.parts?.[0]?.text).toBe('two');
  });

  it('rejects a fractional userMessageIndex', () => {
    expect(() =>
      RecordingSchema.parse({userMessageIndex: 1.5, agentName: 'a'}),
    ).toThrow(z.ZodError);
  });

  it('rejects a quoted userMessageIndex instead of coercing it', () => {
    expect(() =>
      RecordingSchema.parse({userMessageIndex: '0', agentName: 'a'}),
    ).toThrow(z.ZodError);
  });

  it('rejects a scalar where a recorded payload belongs', () => {
    expect(() => LlmRecordingSchema.parse({llmRequest: 'fake-model'})).toThrow(
      'Expected an object',
    );
  });

  it('rejects a null recorded payload', () => {
    expect(() => LlmRecordingSchema.parse({llmRequest: null})).toThrow(
      'Expected an object',
    );
  });
});
