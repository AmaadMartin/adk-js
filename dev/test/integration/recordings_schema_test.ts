/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {parseRecordings} from '../../src/integration/recordings_schema.js';

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
