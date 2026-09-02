/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalCase,
  getAllToolCalls,
  getAllToolCallsWithResponses,
  getAllToolResponses,
  IntermediateData,
  IntermediateDataType,
  Invocation,
  InvocationEvent,
  InvocationEvents,
  isIntermediateData,
  isInvocationEvents,
  Rubric,
  SessionInput,
  validateEvalCase,
} from '@google/adk';
import {FunctionCall, FunctionResponse, Part} from '@google/genai';
import {describe, expect, it} from 'vitest';
// The eval-case module re-exports `ConversationScenario`, mirroring
// adk-python. Only a deep import proves the re-export resolves.
import type {ConversationScenario as ScenarioFromPublicApi} from '@google/adk';
import type {ConversationScenario as ScenarioFromEvalCase} from '../../src/evaluation/eval_case.js';

const TOOL_CALL_SEARCH: FunctionCall = {
  name: 'search',
  args: {query: 'weather'},
};
const TOOL_CALL_LOOKUP: FunctionCall = {name: 'lookup', args: {id: '123'}};
const TOOL_RESPONSE_SEARCH: FunctionResponse = {
  name: 'search',
  response: {result: 'weather is good'},
};
const TOOL_RESPONSE_LOOKUP: FunctionResponse = {
  name: 'lookup',
  response: {id: '123'},
};

/** A malformed value, as an eval-set file on disk can hold one. */
const MALFORMED_INTERMEDIATE_DATA = 'this is not a valid type';

/**
 * The accessors reject a value that is neither shape, so a test needs one.
 * The parameter type excludes it by construction, hence the double cast.
 */
const malformedIntermediateData =
  MALFORMED_INTERMEDIATE_DATA as unknown as IntermediateDataType;

function eventWith(author: string, parts: Part[]): InvocationEvent {
  return {author, content: {parts, role: 'model'}};
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('extra metadata', () => {
  it('keeps undeclared fields on a SessionInput', () => {
    const sessionInput: SessionInput = {
      appName: 'app',
      userId: 'user',
      evalGroup: 'retrieval',
      source: 'nightly',
    };

    expect(sessionInput['evalGroup']).toBe('retrieval');
    expect(roundTrip(sessionInput)['source']).toBe('nightly');
  });

  it('keeps undeclared fields on an EvalCase and its session input', () => {
    const evalCase: EvalCase = {
      evalId: 'case_1',
      conversation: [],
      creationTimestamp: 0,
      sessionInput: {appName: 'app', userId: 'user', source: 'nightly'},
      owner: 'platform',
    };

    expect(evalCase['owner']).toBe('platform');
    const dumped = roundTrip(evalCase);
    expect(dumped['owner']).toBe('platform');
    expect(dumped.sessionInput?.['source']).toBe('nightly');
  });
});

describe('shape', () => {
  it('accepts an InvocationEvent without content', () => {
    const event: InvocationEvent = {author: 'agent'};

    expect(event.content).toBeUndefined();
    expect(roundTrip(event).content).toBeUndefined();
  });

  it('round-trips a fixed session id', () => {
    const sessionInput: SessionInput = {
      appName: 'a',
      userId: 'u',
      sessionId: 's1',
    };

    expect(roundTrip(sessionInput).sessionId).toBe('s1');
  });

  it('allows a SessionInput without a session id', () => {
    const sessionInput: SessionInput = {appName: 'a', userId: 'u'};

    expect(sessionInput.sessionId).toBeUndefined();
  });

  it('round-trips rubrics on an invocation and on an eval case', () => {
    const rubric: Rubric = {
      rubricId: 'r1',
      rubricContent: {textProperty: 'The response is grammatical.'},
      description: 'Score 1 when the response reads correctly.',
      type: 'FINAL_RESPONSE_QUALITY',
    };
    const invocation: Invocation = {
      userContent: {parts: [{text: 'hi'}], role: 'user'},
      rubrics: [rubric],
    };
    const evalCase: EvalCase = {
      evalId: 'case_1',
      conversation: [invocation],
      creationTimestamp: 0,
      rubrics: [rubric],
    };

    const dumped = roundTrip(evalCase);
    expect(dumped.rubrics?.[0]?.rubricContent.textProperty).toBe(
      'The response is grammatical.',
    );
    expect(dumped.conversation?.[0]?.rubrics?.[0]?.type).toBe(
      'FINAL_RESPONSE_QUALITY',
    );
  });

  it('re-exports ConversationScenario from the eval-case module', () => {
    const scenario: ScenarioFromEvalCase = {
      startingPrompt: 'I need to book a flight.',
      conversationPlan: 'Book a morning flight, then confirm it.',
    };
    const fromPublicApi: ScenarioFromPublicApi = scenario;

    expect(fromPublicApi.startingPrompt).toBe('I need to book a flight.');
  });
});

describe('type guards', () => {
  it('recognises invocation events', () => {
    expect(isInvocationEvents({invocationEvents: []})).toBe(true);
    expect(isInvocationEvents({toolUses: []})).toBe(false);
    expect(isInvocationEvents(MALFORMED_INTERMEDIATE_DATA)).toBe(false);
    expect(isInvocationEvents(7)).toBe(false);
    expect(isInvocationEvents(null)).toBe(false);
    expect(isInvocationEvents([])).toBe(false);
  });

  it('recognises intermediate data', () => {
    expect(isIntermediateData({toolUses: [], toolResponses: []})).toBe(true);
    expect(isIntermediateData({intermediateResponses: []})).toBe(true);
    expect(isIntermediateData({})).toBe(true);
    expect(isIntermediateData({toolUses: 'nope'})).toBe(false);
    expect(isIntermediateData({invocationEvents: []})).toBe(false);
    expect(isIntermediateData(MALFORMED_INTERMEDIATE_DATA)).toBe(false);
    expect(isIntermediateData(7)).toBe(false);
    expect(isIntermediateData(null)).toBe(false);
    expect(isIntermediateData([])).toBe(false);
  });
});

describe('getAllToolCalls', () => {
  it('returns nothing for undefined intermediate data', () => {
    expect(getAllToolCalls(undefined)).toEqual([]);
  });

  it('returns nothing when the recorded data holds no tool call', () => {
    expect(getAllToolCalls({toolUses: []})).toEqual([]);
  });

  it('defaults an absent toolUses to nothing', () => {
    expect(getAllToolCalls({toolResponses: []})).toEqual([]);
  });

  it('returns the recorded tool calls in order', () => {
    const intermediateData: IntermediateData = {
      toolUses: [TOOL_CALL_SEARCH, TOOL_CALL_LOOKUP],
    };

    expect(getAllToolCalls(intermediateData)).toEqual([
      TOOL_CALL_SEARCH,
      TOOL_CALL_LOOKUP,
    ]);
  });

  it('returns nothing for an empty list of events', () => {
    expect(getAllToolCalls({invocationEvents: []})).toEqual([]);
  });

  it('returns nothing when no event holds a tool call', () => {
    const intermediateData: InvocationEvents = {
      invocationEvents: [eventWith('agent', [{text: 'Thinking...'}])],
    };

    expect(getAllToolCalls(intermediateData)).toEqual([]);
  });

  it('skips an event with no content and one with no parts', () => {
    const intermediateData: InvocationEvents = {
      invocationEvents: [
        {author: 'agent'},
        {author: 'agent', content: {role: 'model'}},
        eventWith('agent', [{functionCall: TOOL_CALL_SEARCH}]),
      ],
    };

    expect(getAllToolCalls(intermediateData)).toEqual([TOOL_CALL_SEARCH]);
  });

  it('collects tool calls across events, in order', () => {
    const intermediateData: InvocationEvents = {
      invocationEvents: [
        eventWith('agent1', [{functionCall: TOOL_CALL_SEARCH}]),
        eventWith('agent2', [
          {text: 'Found something.'},
          {functionCall: TOOL_CALL_LOOKUP},
        ]),
      ],
    };

    expect(getAllToolCalls(intermediateData)).toEqual([
      TOOL_CALL_SEARCH,
      TOOL_CALL_LOOKUP,
    ]);
  });

  it('rejects a value that is neither shape', () => {
    expect(() => getAllToolCalls(malformedIntermediateData)).toThrow(
      /Unsupported type for intermediate_data/,
    );
  });
});

describe('getAllToolResponses', () => {
  it('returns nothing for undefined intermediate data', () => {
    expect(getAllToolResponses(undefined)).toEqual([]);
  });

  it('returns nothing when the recorded data holds no tool response', () => {
    expect(getAllToolResponses({toolResponses: []})).toEqual([]);
  });

  it('defaults an absent toolResponses to nothing', () => {
    expect(getAllToolResponses({toolUses: []})).toEqual([]);
  });

  it('returns the recorded tool responses in order', () => {
    const intermediateData: IntermediateData = {
      toolResponses: [TOOL_RESPONSE_SEARCH, TOOL_RESPONSE_LOOKUP],
    };

    expect(getAllToolResponses(intermediateData)).toEqual([
      TOOL_RESPONSE_SEARCH,
      TOOL_RESPONSE_LOOKUP,
    ]);
  });

  it('returns nothing for an empty list of events', () => {
    expect(getAllToolResponses({invocationEvents: []})).toEqual([]);
  });

  it('returns nothing when no event holds a tool response', () => {
    const intermediateData: InvocationEvents = {
      invocationEvents: [eventWith('agent', [{text: 'Thinking...'}])],
    };

    expect(getAllToolResponses(intermediateData)).toEqual([]);
  });

  it('skips an event with no content and one with no parts', () => {
    const intermediateData: InvocationEvents = {
      invocationEvents: [
        {author: 'agent'},
        {author: 'agent', content: {role: 'model'}},
        eventWith('tool', [{functionResponse: TOOL_RESPONSE_SEARCH}]),
      ],
    };

    expect(getAllToolResponses(intermediateData)).toEqual([
      TOOL_RESPONSE_SEARCH,
    ]);
  });

  it('collects tool responses across events, in order', () => {
    const intermediateData: InvocationEvents = {
      invocationEvents: [
        eventWith('agent1', [{functionResponse: TOOL_RESPONSE_SEARCH}]),
        eventWith('agent2', [
          {text: 'Found something.'},
          {functionResponse: TOOL_RESPONSE_LOOKUP},
        ]),
      ],
    };

    expect(getAllToolResponses(intermediateData)).toEqual([
      TOOL_RESPONSE_SEARCH,
      TOOL_RESPONSE_LOOKUP,
    ]);
  });

  it('rejects a value that is neither shape', () => {
    expect(() => getAllToolResponses(malformedIntermediateData)).toThrow(
      /Unsupported type for intermediate_data/,
    );
  });
});

describe('getAllToolCallsWithResponses', () => {
  const call1: FunctionCall = {
    name: 'search',
    args: {query: 'weather'},
    id: 'call1',
  };
  const call2: FunctionCall = {name: 'lookup', args: {id: '123'}, id: 'call2'};
  const response1: FunctionResponse = {
    name: 'search',
    response: {result: 'sunny'},
    id: 'call1',
  };

  it('returns nothing for undefined intermediate data', () => {
    expect(getAllToolCallsWithResponses(undefined)).toEqual([]);
  });

  it('returns nothing when the recorded data holds no tool call', () => {
    expect(
      getAllToolCallsWithResponses({toolUses: [], toolResponses: []}),
    ).toEqual([]);
  });

  it('pairs a recorded call with its response, and leaves the rest unpaired', () => {
    const intermediateData: IntermediateData = {
      toolUses: [call1, call2],
      toolResponses: [response1],
    };

    expect(getAllToolCallsWithResponses(intermediateData)).toEqual([
      [call1, response1],
      [call2, undefined],
    ]);
  });

  it('returns nothing for an empty list of events', () => {
    expect(getAllToolCallsWithResponses({invocationEvents: []})).toEqual([]);
  });

  it('pairs a call with a response recorded in a later event', () => {
    const intermediateData: InvocationEvents = {
      invocationEvents: [
        eventWith('agent', [{functionCall: call1}, {functionCall: call2}]),
        eventWith('tool', [{functionResponse: response1}]),
      ],
    };

    expect(getAllToolCallsWithResponses(intermediateData)).toEqual([
      [call1, response1],
      [call2, undefined],
    ]);
  });

  it('keeps the last response when two share one id', () => {
    const firstResponse: FunctionResponse = {
      name: 'search',
      response: {result: 'stale'},
      id: 'call1',
    };
    const intermediateData: IntermediateData = {
      toolUses: [call1],
      toolResponses: [firstResponse, response1],
    };

    expect(getAllToolCallsWithResponses(intermediateData)).toEqual([
      [call1, response1],
    ]);
  });

  it('leaves a call unpaired when its id names a prototype property', () => {
    const inheritedIdCall: FunctionCall = {name: 'search', id: 'constructor'};
    const intermediateData: IntermediateData = {
      toolUses: [inheritedIdCall],
      toolResponses: [response1],
    };

    expect(getAllToolCallsWithResponses(intermediateData)).toEqual([
      [inheritedIdCall, undefined],
    ]);
  });

  it('pairs a call and a response that both have no id', () => {
    const intermediateData: IntermediateData = {
      toolUses: [TOOL_CALL_SEARCH],
      toolResponses: [TOOL_RESPONSE_SEARCH],
    };

    expect(getAllToolCallsWithResponses(intermediateData)).toEqual([
      [TOOL_CALL_SEARCH, TOOL_RESPONSE_SEARCH],
    ]);
  });
});

describe('validateEvalCase', () => {
  const scenario: ScenarioFromPublicApi = {
    startingPrompt: '',
    conversationPlan: '',
  };
  const xorMessage =
    /Exactly one of conversation and conversationScenario must be provided in an EvalCase\./;

  it('rejects a case with neither a conversation nor a scenario', () => {
    expect(() =>
      validateEvalCase({evalId: 'test_id', creationTimestamp: 0}),
    ).toThrow(xorMessage);
  });

  it('rejects a case with both a conversation and a scenario', () => {
    expect(() =>
      validateEvalCase({
        evalId: 'test_id',
        creationTimestamp: 0,
        conversation: [],
        conversationScenario: scenario,
      }),
    ).toThrow(xorMessage);
  });

  it('accepts an empty conversation as a conversation', () => {
    expect(() =>
      validateEvalCase({
        evalId: 'test_id',
        creationTimestamp: 0,
        conversation: [],
      }),
    ).not.toThrow();
  });

  it('accepts a case with only a scenario', () => {
    expect(() =>
      validateEvalCase({
        evalId: 'test_id',
        creationTimestamp: 0,
        conversationScenario: scenario,
      }),
    ).not.toThrow();
  });
});
