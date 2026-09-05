/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// The suite below `parseRecordings` is ported from adk-python
// tests/unittests/cli/plugins/test_recordings_schema.py (branch: main).

import yaml from 'js-yaml';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  LlmRecordingSchema,
  parseRecordings,
  Recording,
  RecordingSchema,
  RecordingsSchema,
  ToolRecordingSchema,
} from '../../src/integration/recordings_schema.js';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

describe('parseRecordings', () => {
  it('converts the structural keys of a recording to camelCase', () => {
    const parsed = parseRecordings({
      recordings: [
        {
          user_message_index: 2,
          agent_name: 'agent_a',
          tool_recording: {
            tool_call: {id: 'fc-1', name: 'roll_die', args: {sides: 6}},
            tool_response: {id: 'fc-1', name: 'roll_die', response: {r: 4}},
          },
        },
      ],
    });

    expect(parsed.recordings[0]).toMatchObject({
      userMessageIndex: 2,
      agentName: 'agent_a',
      toolRecording: {
        toolCall: {id: 'fc-1', name: 'roll_die'},
        toolResponse: {id: 'fc-1', name: 'roll_die'},
      },
    });
  });

  it('leaves the keys inside the recorded args and response verbatim', () => {
    const parsed = parseRecordings({
      recordings: [
        {
          user_message_index: 0,
          agent_name: 'agent_a',
          tool_recording: {
            tool_call: {name: 'greet', args: {user_name: 'ada'}},
            tool_response: {name: 'greet', response: {greeting_text: 'hi'}},
          },
        },
      ],
    });

    const toolRecording = parsed.recordings[0].toolRecording;
    expect(toolRecording?.toolCall?.args).toEqual({user_name: 'ada'});
    expect(toolRecording?.toolResponse?.response).toEqual({
      greeting_text: 'hi',
    });
  });

  it('converts the structural keys of an LLM recording to camelCase', () => {
    const parsed = parseRecordings({
      recordings: [
        {
          user_message_index: 0,
          agent_name: 'agent_a',
          llm_recording: {
            llm_request: {model: 'gemini'},
            llm_responses: [{content: {role: 'model'}}],
          },
        },
      ],
    });

    expect(parsed.recordings[0].llmRecording).toEqual({
      llmRequest: {model: 'gemini'},
      llmResponses: [{content: {role: 'model'}}],
    });
  });

  it('rejects a misspelled key on a recording', () => {
    let caught: unknown;
    try {
      parseRecordings({
        recordings: [
          {user_message_index: 0, agent_name: 'a', tool_recordings: {}},
        ],
      });
    } catch (e: unknown) {
      caught = e;
    }

    expect(errorMessage(caught)).toContain('tool_recordings');
  });

  it('rejects a recording that has no agent name', () => {
    expect(() =>
      parseRecordings({recordings: [{user_message_index: 0}]}),
    ).toThrow();
  });

  it('accepts an extra genai field on a recorded response', () => {
    const parsed = parseRecordings({
      recordings: [
        {
          user_message_index: 0,
          agent_name: 'agent_a',
          tool_recording: {
            tool_response: {name: 'roll_die', will_continue: true},
          },
        },
      ],
    });

    expect(parsed.recordings[0].toolRecording?.toolResponse).toMatchObject({
      name: 'roll_die',
      will_continue: true,
    });
  });

  it('defaults a file with no recordings key to an empty list', () => {
    expect(parseRecordings({})).toEqual({recordings: []});
  });

  it('rejects a file that is not a mapping', () => {
    expect(() => parseRecordings('recordings')).toThrow();
  });
});

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
