/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {convertLegacyEvalSet, isInvocationEvents} from '@google/adk';
import {describe, expect, it} from 'vitest';

const LEGACY_TURN = {
  query: 'Roll a 6 sided dice',
  reference: 'I rolled a 4.',
  expected_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
  expected_intermediate_agent_responses: [
    {author: 'root_agent', text: 'Rolling.'},
  ],
};

describe('convertLegacyEvalSet', () => {
  it('builds an invocation out of query, reference and tool use', () => {
    const evalSet = convertLegacyEvalSet('set-1', [
      {name: 'roll_die', data: [LEGACY_TURN]},
    ]);

    expect(evalSet.evalSetId).toBe('set-1');
    expect(evalSet.evalCases).toHaveLength(1);
    const invocation = evalSet.evalCases[0].conversation?.[0];
    expect(evalSet.evalCases[0].evalId).toBe('roll_die');
    expect(invocation?.userContent).toEqual({
      parts: [{text: 'Roll a 6 sided dice'}],
      role: 'user',
    });
    expect(invocation?.finalResponse).toEqual({
      parts: [{text: 'I rolled a 4.'}],
      role: 'model',
    });
    expect(invocation?.invocationId).not.toBe('');
    const intermediateData = invocation?.intermediateData;
    if (!intermediateData || isInvocationEvents(intermediateData)) {
      expect.fail('expected recorded intermediate data');
    }
    expect(intermediateData.toolUses).toEqual([
      {name: 'roll_die', args: {sides: 6}},
    ]);
    expect(intermediateData.intermediateResponses).toEqual([
      ['root_agent', [{text: 'Rolling.'}]],
    ]);
  });

  it('carries the initial session into the session input', () => {
    const evalSet = convertLegacyEvalSet('set-1', [
      {
        name: 'roll_die',
        data: [LEGACY_TURN],
        initialSession: {
          app_name: 'hello_world',
          user_id: 'user',
          state: {last_roll: 4},
        },
      },
    ]);

    expect(evalSet.evalCases[0].sessionInput).toEqual({
      appName: 'hello_world',
      userId: 'user',
      state: {last_roll: 4},
    });
  });

  it('defaults the names and the state of a partial initial session', () => {
    const evalSet = convertLegacyEvalSet('set-1', [
      {name: 'roll_die', data: [LEGACY_TURN], initialSession: {user_id: 'u'}},
    ]);

    expect(evalSet.evalCases[0].sessionInput).toEqual({
      appName: '',
      userId: 'u',
      state: {},
    });
  });

  it.each([
    ['an absent initial session', undefined],
    ['an empty initial session', {}],
  ])('leaves out the session input for %s', (_name, initialSession) => {
    const evalSet = convertLegacyEvalSet('set-1', [
      {name: 'roll_die', data: [LEGACY_TURN], initialSession},
    ]);

    expect(evalSet.evalCases[0].sessionInput).toBeUndefined();
  });

  it('defaults every optional field of a bare turn', () => {
    const evalSet = convertLegacyEvalSet('set-1', [
      {name: 'bare', data: [{query: 'hi'}]},
    ]);

    const invocation = evalSet.evalCases[0].conversation?.[0];
    expect(invocation?.finalResponse).toEqual({
      parts: [{text: ''}],
      role: 'model',
    });
    expect(invocation?.intermediateData).toEqual({
      toolUses: [],
      toolResponses: [],
      intermediateResponses: [],
    });
  });

  it('skips tool uses and responses that are not objects', () => {
    const evalSet = convertLegacyEvalSet('set-1', [
      {
        name: 'noisy',
        data: [
          {
            query: 'hi',
            expected_tool_use: ['nope', {tool_name: 'roll_die'}],
            expected_intermediate_agent_responses: ['nope'],
          },
        ],
      },
    ]);

    const intermediateData =
      evalSet.evalCases[0].conversation?.[0].intermediateData;
    expect(intermediateData).toEqual({
      toolUses: [{name: 'roll_die', args: {}}],
      toolResponses: [],
      intermediateResponses: [],
    });
  });
});
