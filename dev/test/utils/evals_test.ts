/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, createSession, Event, Session} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {convertSessionToEvalFormat} from '../../src/utils/evals.js';

function userEvent(text: string): Event {
  return createEvent({
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

function agentEvent(
  parts: Part[],
  author: string | undefined = 'agent',
): Event {
  return createEvent({author, content: {role: 'model', parts}});
}

function sessionOf(events: Event[]): Session {
  return createSession({id: 's1', appName: 'app', userId: 'u1', events});
}

describe('convertSessionToEvalFormat', () => {
  it('converts a multi-turn session into one record per turn', () => {
    const session = sessionOf([
      userEvent('turn off device_2 in the Bedroom'),
      agentEvent([
        {
          functionCall: {
            name: 'set_device_info',
            args: {device_id: 'device_2', status: 'OFF'},
          },
        },
      ]),
      agentEvent([{text: 'I have set the device_2 status to off.'}]),
      userEvent('what is the status of device_2?'),
      agentEvent([{text: 'device_2 is off.'}]),
    ]);

    expect(convertSessionToEvalFormat(session)).toEqual([
      {
        query: 'turn off device_2 in the Bedroom',
        expected_tool_use: [
          {
            tool_name: 'set_device_info',
            tool_input: {device_id: 'device_2', status: 'OFF'},
          },
        ],
        expected_intermediate_agent_responses: [],
        reference: 'I have set the device_2 status to off.',
      },
      {
        query: 'what is the status of device_2?',
        expected_tool_use: [],
        expected_intermediate_agent_responses: [],
        reference: 'device_2 is off.',
      },
    ]);
  });

  it('returns an empty array for a session with no events', () => {
    expect(convertSessionToEvalFormat(sessionOf([]))).toEqual([]);
  });

  it('returns an empty array when no event is authored by the user', () => {
    const session = sessionOf([
      agentEvent([{text: 'hello'}]),
      agentEvent([{functionCall: {name: 'noop', args: {}}}]),
    ]);

    expect(convertSessionToEvalFormat(session)).toEqual([]);
  });

  it('returns an empty array for an undefined session', () => {
    expect(convertSessionToEvalFormat(undefined)).toEqual([]);
  });

  it('skips a user event that carries no content', () => {
    const session = sessionOf([
      createEvent({author: 'user'}),
      userEvent('real query'),
      agentEvent([{text: 'answer'}]),
    ]);

    expect(convertSessionToEvalFormat(session)).toEqual([
      {
        query: 'real query',
        expected_tool_use: [],
        expected_intermediate_agent_responses: [],
        reference: 'answer',
      },
    ]);
  });

  it('skips a user event whose parts array is empty', () => {
    const session = sessionOf([
      createEvent({author: 'user', content: {role: 'user', parts: []}}),
      userEvent('real query'),
      agentEvent([{text: 'answer'}]),
    ]);

    expect(convertSessionToEvalFormat(session)).toEqual([
      {
        query: 'real query',
        expected_tool_use: [],
        expected_intermediate_agent_responses: [],
        reference: 'answer',
      },
    ]);
  });

  it('emits an empty query when the first user part has no text', () => {
    const session = sessionOf([
      createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [{inlineData: {data: 'AA=='}}, {text: 'ignored'}],
        },
      }),
      agentEvent([{text: 'answer'}]),
    ]);

    expect(convertSessionToEvalFormat(session)).toEqual([
      {
        query: '',
        expected_tool_use: [],
        expected_intermediate_agent_responses: [],
        reference: 'answer',
      },
    ]);
  });

  it('records an absent or empty author as agent without closing the turn', () => {
    const session = sessionOf([
      userEvent('query'),
      agentEvent([{text: 'from an unnamed author'}], undefined),
      agentEvent([{text: 'from an empty author'}], ''),
      agentEvent([{text: 'final'}]),
    ]);

    expect(convertSessionToEvalFormat(session)).toEqual([
      {
        query: 'query',
        expected_tool_use: [],
        expected_intermediate_agent_responses: [
          {author: 'agent', text: 'from an unnamed author'},
          {author: 'agent', text: 'from an empty author'},
        ],
        reference: 'final',
      },
    ]);
  });

  it('skips a contentless agent event without closing the turn', () => {
    const session = sessionOf([
      userEvent('query'),
      createEvent({author: 'agent'}),
      createEvent({author: 'agent', content: {role: 'model', parts: []}}),
      agentEvent([{functionCall: {name: 'late_tool', args: {a: 1}}}]),
      agentEvent([{text: 'answer'}]),
    ]);

    expect(convertSessionToEvalFormat(session)).toEqual([
      {
        query: 'query',
        expected_tool_use: [{tool_name: 'late_tool', tool_input: {a: 1}}],
        expected_intermediate_agent_responses: [],
        reference: 'answer',
      },
    ]);
  });

  it('records a part holding both a function call and text as a tool use only', () => {
    const session = sessionOf([
      userEvent('query'),
      agentEvent([
        {functionCall: {name: 'both', args: {k: 'v'}}, text: 'dropped'},
      ]),
    ]);

    expect(convertSessionToEvalFormat(session)).toEqual([
      {
        query: 'query',
        expected_tool_use: [{tool_name: 'both', tool_input: {k: 'v'}}],
        expected_intermediate_agent_responses: [],
        reference: '',
      },
    ]);
  });

  it('scans forward from each occurrence of one repeated user event', () => {
    const repeated = userEvent('same query');
    const session = sessionOf([
      repeated,
      agentEvent([{functionCall: {name: 'first_tool', args: {}}}]),
      repeated,
      agentEvent([{functionCall: {name: 'second_tool', args: {}}}]),
    ]);

    const turns = convertSessionToEvalFormat(session);

    expect(turns).toHaveLength(2);
    expect(turns[0].expected_tool_use).toEqual([
      {tool_name: 'first_tool', tool_input: {}},
    ]);
    expect(turns[1].expected_tool_use).toEqual([
      {tool_name: 'second_tool', tool_input: {}},
    ]);
  });

  it('emits one turn per user event when two user events are equal', () => {
    const session = sessionOf([
      userEvent('same query'),
      agentEvent([{text: 'first answer'}]),
      userEvent('same query'),
      agentEvent([{text: 'second answer'}]),
    ]);

    const turns = convertSessionToEvalFormat(session);

    expect(turns.map((turn) => turn.reference)).toEqual([
      'first answer',
      'second answer',
    ]);
  });

  it('defaults a function call with no name and no arguments', () => {
    const session = sessionOf([
      userEvent('query'),
      agentEvent([{functionCall: {}}]),
    ]);

    expect(convertSessionToEvalFormat(session)).toEqual([
      {
        query: 'query',
        expected_tool_use: [{tool_name: '', tool_input: {}}],
        expected_intermediate_agent_responses: [],
        reference: '',
      },
    ]);
  });

  it('ignores an empty-string text part', () => {
    const session = sessionOf([userEvent('query'), agentEvent([{text: ''}])]);

    expect(convertSessionToEvalFormat(session)).toEqual([
      {
        query: 'query',
        expected_tool_use: [],
        expected_intermediate_agent_responses: [],
        reference: '',
      },
    ]);
  });

  it('takes the last text response as the reference', () => {
    const session = sessionOf([
      userEvent('query'),
      agentEvent([{text: 'first'}], 'planner'),
      agentEvent([{text: 'second'}], 'researcher'),
      agentEvent([{text: 'third'}]),
    ]);

    expect(convertSessionToEvalFormat(session)).toEqual([
      {
        query: 'query',
        expected_tool_use: [],
        expected_intermediate_agent_responses: [
          {author: 'planner', text: 'first'},
          {author: 'researcher', text: 'second'},
        ],
        reference: 'third',
      },
    ]);
  });

  it('closes a turn at the next user event', () => {
    const session = sessionOf([
      userEvent('first query'),
      agentEvent([{text: 'first answer'}]),
      userEvent('second query'),
      agentEvent([{functionCall: {name: 'second_tool', args: {}}}]),
      agentEvent([{text: 'second answer'}]),
    ]);

    const turns = convertSessionToEvalFormat(session);

    expect(turns[0]).toEqual({
      query: 'first query',
      expected_tool_use: [],
      expected_intermediate_agent_responses: [],
      reference: 'first answer',
    });
    expect(turns[1].expected_tool_use).toEqual([
      {tool_name: 'second_tool', tool_input: {}},
    ]);
  });

  it('does not mutate the session and shares the function call arguments', () => {
    const args = {device_id: 'device_2'};
    const session = sessionOf([
      userEvent('query'),
      agentEvent([{functionCall: {name: 'set_device_info', args}}]),
      agentEvent([{text: 'answer'}]),
    ]);
    const before = JSON.stringify(session);

    const turns = convertSessionToEvalFormat(session);

    expect(JSON.stringify(session)).toBe(before);
    expect(turns[0].expected_tool_use[0].tool_input).toBe(args);
  });
});
