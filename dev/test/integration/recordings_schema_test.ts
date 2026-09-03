/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python
// tests/unittests/cli/plugins/test_recordings_schema.py (branch: main).

import yaml from 'js-yaml';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  LlmRecordingSchema,
  Recording,
  RecordingSchema,
  RecordingsSchema,
  ToolRecordingSchema,
} from '../../src/integration/recordings_schema.js';

function toolRecording(): Recording {
  return {
    userMessageIndex: 0,
    agentName: 'dice_agent',
    toolRecording: {
      toolCall: {id: 'fc-1', name: 'roll_die', args: {sides: 6}},
      toolResponse: {id: 'fc-1', name: 'roll_die', response: {result: 4}},
    },
  };
}

function llmRecording(): Recording {
  return {
    userMessageIndex: 1,
    agentName: 'dice_agent',
    llmRecording: {
      llmRequest: {
        model: 'fake-model',
        contents: [{role: 'user', parts: [{text: 'roll a die'}]}],
        liveConnectConfig: {},
        toolsDict: {},
      },
      llmResponses: [{content: {role: 'model', parts: [{text: 'rolled a 4'}]}}],
    },
  };
}

const UNKNOWN_FIELD_CASES: Array<[string, z.ZodType, Record<string, unknown>]> =
  [
    ['Recordings', RecordingsSchema, {recordings: []}],
    ['Recording', RecordingSchema, {userMessageIndex: 0, agentName: 'a'}],
    ['LlmRecording', LlmRecordingSchema, {llmResponses: []}],
    ['ToolRecording', ToolRecordingSchema, {}],
  ];

describe('recordings schema', () => {
  it('test_recordings_round_trip_through_yaml_preserves_recordings', () => {
    const recordings = {recordings: [toolRecording(), llmRecording()]};

    // The JSON pass drops undefined, the analogue of the recorder's
    // exclude_none dump.
    const dumped = yaml.dump(JSON.parse(JSON.stringify(recordings)), {
      sortKeys: false,
    });
    const reloaded = RecordingsSchema.parse(yaml.load(dumped));

    expect(reloaded).toEqual(recordings);

    // Guard against a degenerate match of two empty models: the fields the
    // replayer actually reads must survive the round trip.
    const tool = reloaded.recordings[0].toolRecording;
    expect(tool?.toolCall?.name).toBe('roll_die');
    expect(tool?.toolCall?.args).toEqual({sides: 6});
    expect(tool?.toolResponse?.response).toEqual({result: 4});
    const llm = reloaded.recordings[1].llmRecording;
    expect(llm?.llmRequest?.model).toBe('fake-model');
    expect(llm?.llmResponses?.[0]?.content?.parts?.[0]?.text).toBe(
      'rolled a 4',
    );
  });

  it.each(UNKNOWN_FIELD_CASES)(
    'test_recording_models_reject_unknown_fields [%s]',
    (_name, schema, payload) => {
      expect(() => schema.parse({...payload})).not.toThrow();

      const parseWithStrayKey = () =>
        schema.parse({...payload, notARealField: 1});
      expect(parseWithStrayKey).toThrow(z.ZodError);
      expect(parseWithStrayKey).toThrow('notARealField');
    },
  );

  it('test_recordings_rejects_unknown_field_nested_in_a_recording', () => {
    const parseNestedStrayKey = () =>
      RecordingsSchema.parse({
        recordings: [
          {
            userMessageIndex: 0,
            agentName: 'a',
            // Plural typo of `toolRecording`.
            toolRecordings: {toolCall: {name: 'roll_die'}},
          },
        ],
      });

    expect(parseNestedStrayKey).toThrow(z.ZodError);
    expect(parseNestedStrayKey).toThrow('toolRecordings');
  });

  it('test_recording_requires_the_fields_replay_filters_on', () => {
    expect(() => RecordingSchema.parse({toolRecording: undefined})).toThrow(
      z.ZodError,
    );

    const result = RecordingSchema.safeParse({toolRecording: undefined});
    if (result.success) {
      expect.fail('expected a Recording without the filter fields to fail');
    }
    const paths = result.error.issues.map((issue) => issue.path.join('.'));
    expect(paths).toContain('userMessageIndex');
    expect(paths).toContain('agentName');
  });
});
