/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalSet} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  EvalSetSchemaError,
  parseEvalSet,
  serializeEvalSet,
} from '../../src/evaluation/eval_json.js';

/** An eval set as adk-python writes it: snake_case, nested genai payloads. */
const ON_DISK = {
  eval_set_id: 'home_automation',
  name: 'Home automation',
  description: 'Two turns.',
  creation_timestamp: 12.5,
  eval_cases: [
    {
      eval_id: 'turn_off',
      creation_timestamp: 13.5,
      conversation: [
        {
          invocation_id: 'inv-1',
          user_content: {parts: [{text: 'Turn it off'}], role: 'user'},
          final_response: {parts: [{text: 'Done'}], role: 'model'},
          intermediate_data: {
            tool_uses: [
              {name: 'set_device_info', args: {device_id: 'd1', status: 'OFF'}},
            ],
            tool_responses: [],
            intermediate_responses: [],
          },
          creation_timestamp: 14.5,
        },
      ],
      session_input: {
        app_name: 'home_automation',
        user_id: 'user',
        session_id: 'fixed-session',
        state: {last_device_id: 'd1'},
      },
      final_session_state: {last_device_id: 'd1'},
    },
  ],
};

describe('parseEvalSet', () => {
  it('reads snake_case fields into camelCase ones', () => {
    const evalSet = parseEvalSet(ON_DISK);

    expect(evalSet.evalSetId).toBe('home_automation');
    expect(evalSet.name).toBe('Home automation');
    expect(evalSet.description).toBe('Two turns.');
    expect(evalSet.creationTimestamp).toBe(12.5);
    expect(evalSet.evalCases[0].evalId).toBe('turn_off');
    expect(evalSet.evalCases[0].sessionInput).toEqual({
      appName: 'home_automation',
      userId: 'user',
      sessionId: 'fixed-session',
      state: {last_device_id: 'd1'},
    });
  });

  it('leaves tool arguments and session state keys alone', () => {
    const evalSet = parseEvalSet(ON_DISK);
    const invocation = evalSet.evalCases[0].conversation?.[0];
    const intermediateData = invocation?.intermediateData;

    expect(intermediateData).toEqual({
      toolUses: [
        {name: 'set_device_info', args: {device_id: 'd1', status: 'OFF'}},
      ],
      toolResponses: [],
      intermediateResponses: [],
    });
    expect(evalSet.evalCases[0].finalSessionState).toEqual({
      last_device_id: 'd1',
    });
  });

  it('reads an invocation recorded as a list of events', () => {
    const evalSet = parseEvalSet({
      eval_set_id: 'events',
      eval_cases: [
        {
          eval_id: 'case',
          conversation: [
            {
              user_content: {parts: [{text: 'hi'}]},
              intermediate_data: {
                invocation_events: [
                  {
                    author: 'root',
                    content: {parts: [{function_call: {name: 'roll_die'}}]},
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(evalSet.evalCases[0].conversation?.[0].intermediateData).toEqual({
      invocationEvents: [
        {
          author: 'root',
          content: {parts: [{functionCall: {name: 'roll_die'}}]},
        },
      ],
    });
  });

  it('defaults an absent invocation id and timestamp', () => {
    const evalSet = parseEvalSet({
      eval_set_id: 'sparse',
      eval_cases: [
        {eval_id: 'case', conversation: [{user_content: {parts: []}}]},
      ],
    });

    expect(evalSet.creationTimestamp).toBe(0);
    expect(evalSet.evalCases[0].conversation?.[0].invocationId).toBe('');
    expect(evalSet.evalCases[0].sessionInput).toBeUndefined();
    expect(evalSet.name).toBeUndefined();
  });

  it('defaults a session input that omits its names and state', () => {
    const evalSet = parseEvalSet({
      eval_set_id: 'sparse',
      eval_cases: [{eval_id: 'case', session_input: {}}],
    });

    expect(evalSet.evalCases[0].sessionInput).toEqual({
      appName: '',
      userId: '',
      sessionId: undefined,
      state: {},
    });
    expect(evalSet.evalCases[0].conversation).toBeUndefined();
  });

  it('defaults an intermediate data record with no recorded lists', () => {
    const evalSet = parseEvalSet({
      eval_set_id: 'sparse',
      eval_cases: [
        {
          eval_id: 'case',
          conversation: [{user_content: {parts: []}, intermediate_data: {}}],
        },
      ],
    });

    expect(evalSet.evalCases[0].conversation?.[0].intermediateData).toEqual({
      toolUses: [],
      toolResponses: [],
      intermediateResponses: [],
    });
  });

  it('drops array elements that are not objects', () => {
    const evalSet = parseEvalSet({
      eval_set_id: 'noisy',
      eval_cases: [
        {
          eval_id: 'case',
          conversation: [
            {
              user_content: {parts: [{text: 'hi'}, 'not a part']},
              intermediate_data: {
                tool_uses: [1, {name: 'roll_die'}],
                tool_responses: 'not a list',
                intermediate_responses: [
                  ['root', [{text: 'thinking'}, 7]],
                  'not a pair',
                  [42, []],
                ],
              },
            },
          ],
        },
      ],
    });

    const invocation = evalSet.evalCases[0].conversation?.[0];
    expect(invocation?.userContent.parts).toEqual([{text: 'hi'}]);
    expect(invocation?.intermediateData).toEqual({
      toolUses: [{name: 'roll_die'}],
      toolResponses: [],
      intermediateResponses: [['root', [{text: 'thinking'}]]],
    });
  });

  it.each([
    ['a value that is not an object', ['legacy']],
    ['an object with no eval_set_id', {eval_cases: []}],
    ['an object with no eval_cases', {eval_set_id: 'x'}],
    ['an eval case with no eval_id', {eval_set_id: 'x', eval_cases: [{}]}],
    [
      'an invocation that is not an object',
      {eval_set_id: 'x', eval_cases: [{eval_id: 'c', conversation: ['no']}]},
    ],
    [
      'an invocation with no user_content',
      {eval_set_id: 'x', eval_cases: [{eval_id: 'c', conversation: [{}]}]},
    ],
    [
      'an invocation event that is not an object',
      {
        eval_set_id: 'x',
        eval_cases: [
          {
            eval_id: 'c',
            conversation: [
              {
                user_content: {parts: []},
                intermediate_data: {invocation_events: ['no']},
              },
            ],
          },
        ],
      },
    ],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseEvalSet(raw)).toThrowError(EvalSetSchemaError);
  });
});

describe('serializeEvalSet', () => {
  it('round-trips an eval set back to its on-disk form', () => {
    const evalSet = parseEvalSet(ON_DISK);

    expect(JSON.parse(serializeEvalSet(evalSet))).toEqual(ON_DISK);
  });

  it('indents with two spaces', () => {
    const evalSet: EvalSet = {
      evalSetId: 'x',
      evalCases: [],
      creationTimestamp: 0,
    };

    expect(serializeEvalSet(evalSet)).toBe(
      '{\n  "eval_set_id": "x",\n  "eval_cases": [],\n  "creation_timestamp": 0\n}',
    );
  });
});
