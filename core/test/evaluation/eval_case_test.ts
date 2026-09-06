/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalCaseSchema,
  getAllToolCalls,
  getAllToolCallsWithResponses,
  getAllToolResponses,
  IntermediateDataSchema,
  type IntermediateDataType,
  InvocationEventSchema,
  InvocationEventsSchema,
  SessionInputSchema,
} from '@google/adk';
import {Content, FunctionCall, FunctionResponse} from '@google/genai';
import {describe, expect, it} from 'vitest';

describe('evaluation/eval_case', () => {
  describe('extra metadata preservation (loose)', () => {
    it('preserves extra keys on SessionInput and EvalCase', () => {
      const sessionInput = SessionInputSchema.parse({
        appName: 'app',
        userId: 'user',
        evalGroup: 'retrieval',
        source: 'nightly',
      });
      expect(sessionInput['evalGroup']).toBe('retrieval');
      expect(sessionInput['source']).toBe('nightly');
      expect(sessionInput.state).toEqual({});

      const evalCase = EvalCaseSchema.parse({
        evalId: 'case_1',
        conversation: [],
        sessionInput,
        owner: 'platform',
      });
      expect(evalCase['owner']).toBe('platform');
    });
  });

  describe('InvocationEventSchema', () => {
    it('defaults content to undefined and round-trips', () => {
      const event = InvocationEventSchema.parse({author: 'agent'});
      expect(event.content).toBeUndefined();
      expect(InvocationEventSchema.parse({...event}).content).toBeUndefined();
    });
  });

  describe('getAllToolCalls', () => {
    it('returns an empty array for undefined input', () => {
      expect(getAllToolCalls(undefined)).toEqual([]);
    });

    it('returns an empty array for IntermediateData with no tools', () => {
      const data = IntermediateDataSchema.parse({toolUses: []});
      expect(getAllToolCalls(data)).toEqual([]);
    });

    it('extracts tool calls from IntermediateData', () => {
      const call1: FunctionCall = {name: 'search', args: {query: 'weather'}};
      const call2: FunctionCall = {name: 'lookup', args: {id: '123'}};
      const data = IntermediateDataSchema.parse({toolUses: [call1, call2]});
      expect(getAllToolCalls(data)).toEqual([call1, call2]);
    });

    it('returns an empty array for empty InvocationEvents', () => {
      const data = InvocationEventsSchema.parse({invocationEvents: []});
      expect(getAllToolCalls(data)).toEqual([]);
    });

    it('returns an empty array for events without tool calls', () => {
      const data = InvocationEventsSchema.parse({
        invocationEvents: [
          {
            author: 'agent',
            content: {parts: [{text: 'Thinking...'}], role: 'model'},
          },
          // An event without content exercises the optional-content branch.
          {author: 'agent'},
        ],
      });
      expect(getAllToolCalls(data)).toEqual([]);
    });

    it('extracts tool calls from InvocationEvents (single and multi-part)', () => {
      const call1: FunctionCall = {name: 'search', args: {query: 'weather'}};
      const call2: FunctionCall = {name: 'lookup', args: {id: '123'}};
      const data = InvocationEventsSchema.parse({
        invocationEvents: [
          {
            author: 'agent1',
            content: {parts: [{functionCall: call1}], role: 'model'},
          },
          {
            author: 'agent2',
            content: {
              parts: [{text: 'Found something.'}, {functionCall: call2}],
              role: 'model',
            },
          },
        ],
      });
      expect(getAllToolCalls(data)).toEqual([call1, call2]);
    });

    it('throws for an unsupported type (string)', () => {
      expect(() =>
        getAllToolCalls(
          'this is not a valid type' as unknown as IntermediateDataType,
        ),
      ).toThrow('Unsupported type for intermediate_data');
    });

    it('throws for an unsupported object shape', () => {
      expect(() =>
        getAllToolCalls({foo: 'bar'} as unknown as IntermediateDataType),
      ).toThrow('Unsupported type for intermediate_data');
    });
  });

  describe('getAllToolResponses', () => {
    it('returns an empty array for undefined input', () => {
      expect(getAllToolResponses(undefined)).toEqual([]);
    });

    it('returns tool responses from IntermediateData', () => {
      const resp1: FunctionResponse = {name: 'search', response: {r: 'ok'}};
      const data = IntermediateDataSchema.parse({toolResponses: [resp1]});
      expect(getAllToolResponses(data)).toEqual([resp1]);
    });

    it('returns an empty array for empty InvocationEvents', () => {
      const data = InvocationEventsSchema.parse({invocationEvents: []});
      expect(getAllToolResponses(data)).toEqual([]);
    });

    it('returns an empty array for events without tool responses', () => {
      const data = InvocationEventsSchema.parse({
        invocationEvents: [
          {
            author: 'agent',
            content: {parts: [{text: 'Thinking...'}], role: 'model'},
          },
        ],
      });
      expect(getAllToolResponses(data)).toEqual([]);
    });

    it('extracts tool responses from InvocationEvents', () => {
      const resp1: FunctionResponse = {
        name: 'search',
        response: {result: 'weather is good'},
      };
      const resp2: FunctionResponse = {name: 'lookup', response: {id: '123'}};
      const data = InvocationEventsSchema.parse({
        invocationEvents: [
          {
            author: 'agent1',
            content: {parts: [{functionResponse: resp1}], role: 'model'},
          },
          {
            author: 'agent2',
            content: {
              parts: [{text: 'Found something.'}, {functionResponse: resp2}],
              role: 'model',
            },
          },
        ],
      });
      expect(getAllToolResponses(data)).toEqual([resp1, resp2]);
    });

    it('throws for an unsupported type (string)', () => {
      expect(() =>
        getAllToolResponses('nope' as unknown as IntermediateDataType),
      ).toThrow('Unsupported type for intermediate_data');
    });

    it('throws for an unsupported object shape', () => {
      expect(() =>
        getAllToolResponses({foo: 1} as unknown as IntermediateDataType),
      ).toThrow('Unsupported type for intermediate_data');
    });
  });

  describe('getAllToolCallsWithResponses', () => {
    it('returns an empty array for undefined input', () => {
      expect(getAllToolCallsWithResponses(undefined)).toEqual([]);
    });

    it('returns an empty array for IntermediateData with no tool calls', () => {
      const data = IntermediateDataSchema.parse({
        toolUses: [],
        toolResponses: [],
      });
      expect(getAllToolCallsWithResponses(data)).toEqual([]);
    });

    it('pairs matching and non-matching calls from IntermediateData', () => {
      const call1: FunctionCall = {
        name: 'search',
        args: {query: 'weather'},
        id: 'call1',
      };
      const resp1: FunctionResponse = {
        name: 'search',
        response: {result: 'sunny'},
        id: 'call1',
      };
      const call2: FunctionCall = {
        name: 'lookup',
        args: {id: '123'},
        id: 'call2',
      };
      const data = IntermediateDataSchema.parse({
        toolUses: [call1, call2],
        toolResponses: [resp1],
      });
      expect(getAllToolCallsWithResponses(data)).toEqual([
        [call1, resp1],
        [call2, undefined],
      ]);
    });

    it('pairs calls and responses from InvocationEvents', () => {
      const call1: FunctionCall = {
        name: 'search',
        args: {query: 'weather'},
        id: 'call1',
      };
      const resp1: FunctionResponse = {
        name: 'search',
        response: {result: 'sunny'},
        id: 'call1',
      };
      const call2: FunctionCall = {
        name: 'lookup',
        args: {id: '123'},
        id: 'call2',
      };
      const data = InvocationEventsSchema.parse({
        invocationEvents: [
          {
            author: 'agent',
            content: {
              parts: [{functionCall: call1}, {functionCall: call2}],
              role: 'model',
            },
          },
          {
            author: 'tool',
            content: {parts: [{functionResponse: resp1}], role: 'tool'},
          },
        ],
      });
      expect(getAllToolCallsWithResponses(data)).toEqual([
        [call1, resp1],
        [call2, undefined],
      ]);
    });
  });

  describe('EvalCase conversation XOR conversationScenario', () => {
    const scenario = {startingPrompt: '', conversationPlan: ''};

    it('accepts an empty conversation array', () => {
      expect(
        EvalCaseSchema.safeParse({evalId: 'test_id', conversation: []}).success,
      ).toBe(true);
    });

    it('accepts a conversation scenario', () => {
      expect(
        EvalCaseSchema.safeParse({
          evalId: 'test_id',
          conversationScenario: scenario,
        }).success,
      ).toBe(true);
    });

    it('rejects when neither is provided', () => {
      expect(EvalCaseSchema.safeParse({evalId: 'test_id'}).success).toBe(false);
    });

    it('rejects when both are provided', () => {
      const result = EvalCaseSchema.safeParse({
        evalId: 'test_id',
        conversation: [],
        conversationScenario: scenario,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          'Exactly one of conversation and conversation_scenario must be' +
            ' provided in an EvalCase.',
        );
      }
    });
  });

  describe('round-trip serialization', () => {
    it('survives JSON stringify/parse (camelCase stability)', () => {
      const userContent: Content = {
        role: 'user',
        parts: [{text: 'What is the weather?'}],
      };
      const evalCase = EvalCaseSchema.parse({
        evalId: 'case-1',
        conversation: [
          {
            invocationId: 'inv-1',
            userContent,
            creationTimestamp: 0,
            intermediateData: {
              toolUses: [{name: 'search', args: {q: 'weather'}, id: 'c1'}],
              toolResponses: [],
              intermediateResponses: [],
            },
          },
        ],
      });
      const roundTripped = EvalCaseSchema.parse(
        JSON.parse(JSON.stringify(evalCase)),
      );
      expect(roundTripped).toEqual(evalCase);
    });
  });
});
