/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ConversationScenario,
  EvalCase,
  InputValidationError,
  IntermediateData,
  IntermediateDataType,
  Invocation,
  InvocationEvent,
  InvocationEvents,
  Rubric,
  SessionInput,
  getAllToolCalls,
  getAllToolCallsWithResponses,
  getAllToolResponses,
  isIntermediateData,
  isInvocationEvents,
  validateEvalCase,
} from '@google/adk';
import type {FunctionCall, FunctionResponse} from '@google/genai';
import {describe, expect, it} from 'vitest';

const ROLL_DIE = {name: 'roll_die', args: {sides: 6}};
const CHECK_PRIME = {name: 'check_prime', args: {value: 5}};

const INTERMEDIATE_DATA: IntermediateData = {
  toolUses: [ROLL_DIE],
  toolResponses: [],
  intermediateResponses: [],
};

const INVOCATION_EVENTS: InvocationEvents = {
  invocationEvents: [
    {author: 'root', content: {parts: [{functionCall: CHECK_PRIME}]}},
    {author: 'root', content: {parts: [{text: 'thinking'}]}},
    {author: 'root'},
  ],
};

describe('isInvocationEvents', () => {
  it('tells the two intermediate data shapes apart', () => {
    expect(isInvocationEvents(INVOCATION_EVENTS)).toBe(true);
    expect(isInvocationEvents(INTERMEDIATE_DATA)).toBe(false);
  });
});

describe('getAllToolCalls', () => {
  it('returns nothing when there is no intermediate data', () => {
    expect(getAllToolCalls(undefined)).toEqual([]);
  });

  it('returns the recorded tool uses', () => {
    expect(getAllToolCalls(INTERMEDIATE_DATA)).toEqual([ROLL_DIE]);
  });

  it('collects the function calls out of invocation events', () => {
    expect(getAllToolCalls(INVOCATION_EVENTS)).toEqual([CHECK_PRIME]);
  });
});

describe('eval_case', () => {
  const SEARCH_CALL: FunctionCall = {name: 'search', args: {query: 'adk'}};
  const SUMMARIZE_CALL: FunctionCall = {name: 'summarize', args: {}};

  /** Returns intermediate data carrying only the given tool call trajectory. */
  function trajectory(...toolUses: FunctionCall[]): IntermediateData {
    return {toolUses, toolResponses: [], intermediateResponses: []};
  }

  describe('getAllToolCalls', () => {
    it('returns no calls for absent intermediate data', () => {
      expect(getAllToolCalls()).toEqual([]);
    });

    it('returns no calls when the trajectory is empty', () => {
      expect(getAllToolCalls(trajectory())).toEqual([]);
    });

    it('returns the recorded trajectory in order', () => {
      expect(getAllToolCalls(trajectory(SEARCH_CALL, SUMMARIZE_CALL))).toEqual([
        SEARCH_CALL,
        SUMMARIZE_CALL,
      ]);
    });

    it('flattens the calls across events and parts, in order', () => {
      const intermediateData: InvocationEvents = {
        invocationEvents: [
          {author: 'user'},
          {author: 'agent', content: {}},
          {author: 'agent', content: {parts: []}},
          {
            author: 'agent',
            content: {
              parts: [
                {text: 'searching'},
                {functionCall: SEARCH_CALL},
                {functionCall: SUMMARIZE_CALL},
              ],
            },
          },
        ],
      };

      expect(getAllToolCalls(intermediateData)).toEqual([
        SEARCH_CALL,
        SUMMARIZE_CALL,
      ]);
    });
  });

  describe('isInvocationEvents', () => {
    it('accepts the events shape', () => {
      expect(isInvocationEvents({invocationEvents: []})).toBe(true);
    });

    it('rejects the trajectory shape', () => {
      expect(isInvocationEvents(trajectory(SEARCH_CALL))).toBe(false);
    });
  });
});

const XOR_MESSAGE =
  'Exactly one of conversation and conversation_scenario must be provided in' +
  ' an EvalCase.';

const SEARCH_CALL: FunctionCall = {
  id: 'call1',
  name: 'search',
  args: {query: 'weather'},
};
const LOOKUP_CALL: FunctionCall = {
  id: 'call2',
  name: 'lookup',
  args: {id: '123'},
};
const SEARCH_RESPONSE: FunctionResponse = {
  id: 'call1',
  name: 'search',
  response: {result: 'sunny'},
};
const LOOKUP_RESPONSE: FunctionResponse = {
  id: 'call2',
  name: 'lookup',
  response: {id: '123'},
};

const SCENARIO: ConversationScenario = {
  startingPrompt: 'I need to book a flight.',
  conversationPlan: 'Book SFO to LAX next Tuesday under $150, then confirm.',
};

const RUBRIC: Rubric = {
  rubricId: 'tone',
  rubricContent: {textProperty: 'The agent is polite.'},
  type: 'FINAL_RESPONSE_QUALITY',
};

/** Returns recorded intermediate data with the given calls and responses. */
function recorded(
  toolUses: FunctionCall[] = [],
  toolResponses: FunctionResponse[] = [],
): IntermediateData {
  return {toolUses, toolResponses, intermediateResponses: []};
}

/** Returns invocation events whose single event carries the given parts. */
function events(...invocationEvents: InvocationEvent[]): InvocationEvents {
  return {invocationEvents};
}

/**
 * Stands in for malformed data read from an eval set file: it is neither
 * supported shape, which the type system alone cannot express.
 */
const MALFORMED: IntermediateDataType = JSON.parse(
  '"this is not a valid type"',
);

describe('model defaults', () => {
  it('leaves an InvocationEvent without content undefined', () => {
    const event: InvocationEvent = {author: 'agent'};

    expect(event.content).toBeUndefined();

    const roundTripped: InvocationEvent = JSON.parse(JSON.stringify(event));

    expect(roundTripped.content).toBeUndefined();
  });

  it('round-trips a fixed session id', () => {
    const sessionInput: SessionInput = {
      appName: 'a',
      userId: 'u',
      sessionId: 's1',
    };

    const roundTripped: SessionInput = JSON.parse(JSON.stringify(sessionInput));

    expect(roundTripped.sessionId).toBe('s1');
  });

  it('leaves an absent session id undefined', () => {
    const sessionInput: SessionInput = {appName: 'a', userId: 'u'};

    expect(sessionInput.sessionId).toBeUndefined();
  });
});

describe('getAllToolCalls', () => {
  it('returns no calls for absent intermediate data', () => {
    expect(getAllToolCalls()).toEqual([]);
  });

  it('returns no calls when the recorded trajectory is empty', () => {
    expect(getAllToolCalls(recorded())).toEqual([]);
  });

  it('returns the recorded calls in order', () => {
    expect(getAllToolCalls(recorded([SEARCH_CALL, LOOKUP_CALL]))).toEqual([
      SEARCH_CALL,
      LOOKUP_CALL,
    ]);
  });

  it('defaults an omitted recorded call list to empty', () => {
    const partial: IntermediateDataType = JSON.parse('{"toolResponses": []}');

    expect(getAllToolCalls(partial)).toEqual([]);
  });

  it('returns no calls when there are no events', () => {
    expect(getAllToolCalls(events())).toEqual([]);
  });

  it('returns no calls when no event holds one', () => {
    const intermediateData = events({
      author: 'agent',
      content: {role: 'model', parts: [{text: 'Thinking...'}]},
    });

    expect(getAllToolCalls(intermediateData)).toEqual([]);
  });

  it('flattens the calls across events and parts, in order', () => {
    const intermediateData = events(
      {author: 'user'},
      {author: 'agent', content: {}},
      {author: 'agent', content: {role: 'model', parts: []}},
      {
        author: 'agent1',
        content: {role: 'model', parts: [{functionCall: SEARCH_CALL}]},
      },
      {
        author: 'agent2',
        content: {
          role: 'model',
          parts: [{text: 'Found something.'}, {functionCall: LOOKUP_CALL}],
        },
      },
    );

    expect(getAllToolCalls(intermediateData)).toEqual([
      SEARCH_CALL,
      LOOKUP_CALL,
    ]);
  });
});

describe('getAllToolResponses', () => {
  it('returns no responses for absent intermediate data', () => {
    expect(getAllToolResponses()).toEqual([]);
  });

  it('returns no responses when the recorded trajectory is empty', () => {
    expect(getAllToolResponses(recorded())).toEqual([]);
  });

  it('returns the recorded responses in order', () => {
    const intermediateData = recorded([], [SEARCH_RESPONSE, LOOKUP_RESPONSE]);

    expect(getAllToolResponses(intermediateData)).toEqual([
      SEARCH_RESPONSE,
      LOOKUP_RESPONSE,
    ]);
  });

  it('defaults an omitted recorded response list to empty', () => {
    const partial: IntermediateDataType = JSON.parse('{"toolUses": []}');

    expect(getAllToolResponses(partial)).toEqual([]);
  });

  it('returns no responses when there are no events', () => {
    expect(getAllToolResponses(events())).toEqual([]);
  });

  it('returns no responses when no event holds one', () => {
    const intermediateData = events({
      author: 'agent',
      content: {role: 'model', parts: [{text: 'Thinking...'}]},
    });

    expect(getAllToolResponses(intermediateData)).toEqual([]);
  });

  it('flattens the responses across events and parts, in order', () => {
    const intermediateData = events(
      {author: 'agent', content: {}},
      {
        author: 'tool1',
        content: {role: 'tool', parts: [{functionResponse: SEARCH_RESPONSE}]},
      },
      {
        author: 'tool2',
        content: {
          role: 'tool',
          parts: [
            {text: 'Found something.'},
            {functionResponse: LOOKUP_RESPONSE},
          ],
        },
      },
    );

    expect(getAllToolResponses(intermediateData)).toEqual([
      SEARCH_RESPONSE,
      LOOKUP_RESPONSE,
    ]);
  });
});

describe('getAllToolCallsWithResponses', () => {
  it('returns no pairs for absent intermediate data', () => {
    expect(getAllToolCallsWithResponses()).toEqual([]);
  });

  it('returns no pairs when the recorded trajectory has no calls', () => {
    expect(getAllToolCallsWithResponses(recorded())).toEqual([]);
  });

  it('pairs a recorded call without a response with undefined', () => {
    const intermediateData = recorded(
      [SEARCH_CALL, LOOKUP_CALL],
      [SEARCH_RESPONSE],
    );

    expect(getAllToolCallsWithResponses(intermediateData)).toEqual([
      [SEARCH_CALL, SEARCH_RESPONSE],
      [LOOKUP_CALL, undefined],
    ]);
  });

  it('returns no pairs when there are no events', () => {
    expect(getAllToolCallsWithResponses(events())).toEqual([]);
  });

  it('pairs calls and responses that sit in different events', () => {
    const intermediateData = events(
      {
        author: 'agent',
        content: {
          role: 'model',
          parts: [{functionCall: SEARCH_CALL}, {functionCall: LOOKUP_CALL}],
        },
      },
      {
        author: 'tool',
        content: {role: 'tool', parts: [{functionResponse: SEARCH_RESPONSE}]},
      },
    );

    expect(getAllToolCallsWithResponses(intermediateData)).toEqual([
      [SEARCH_CALL, SEARCH_RESPONSE],
      [LOOKUP_CALL, undefined],
    ]);
  });

  it('keeps the last of two responses that share an id', () => {
    const laterResponse: FunctionResponse = {
      id: 'call1',
      name: 'search',
      response: {result: 'rainy'},
    };
    const intermediateData = recorded(
      [SEARCH_CALL],
      [SEARCH_RESPONSE, laterResponse],
    );

    expect(getAllToolCallsWithResponses(intermediateData)).toEqual([
      [SEARCH_CALL, laterResponse],
    ]);
  });

  it('pairs a call and a response that both lack an id', () => {
    const call: FunctionCall = {name: 'search', args: {}};
    const response: FunctionResponse = {name: 'search', response: {}};

    expect(getAllToolCallsWithResponses(recorded([call], [response]))).toEqual([
      [call, response],
    ]);
  });
});

describe('unsupported intermediate data', () => {
  it('rejects it in getAllToolCalls', () => {
    expect(() => getAllToolCalls(MALFORMED)).toThrow(InputValidationError);
    expect(() => getAllToolCalls(MALFORMED)).toThrowError(
      new InputValidationError(
        'Unsupported type for intermediate_data `this is not a valid type`',
      ),
    );
  });

  it('rejects it in getAllToolResponses', () => {
    expect(() => getAllToolResponses(MALFORMED)).toThrow(InputValidationError);
  });

  it('propagates the rejection through getAllToolCallsWithResponses', () => {
    expect(() => getAllToolCallsWithResponses(MALFORMED)).toThrow(
      InputValidationError,
    );
  });

  it('rejects an object that carries evidence of neither shape', () => {
    const empty: IntermediateDataType = JSON.parse('{}');

    expect(() => getAllToolCalls(empty)).toThrow(InputValidationError);
  });
});

describe('validateEvalCase', () => {
  it('rejects an eval case with neither conversation nor scenario', () => {
    expect(() => validateEvalCase({evalId: 'test_id'})).toThrow(
      InputValidationError,
    );
    expect(() => validateEvalCase({evalId: 'test_id'})).toThrowError(
      new InputValidationError(XOR_MESSAGE),
    );
  });

  it('rejects an eval case with both', () => {
    expect(() =>
      validateEvalCase({
        evalId: 'test_id',
        conversation: [],
        conversationScenario: SCENARIO,
      }),
    ).toThrowError(new InputValidationError(XOR_MESSAGE));
  });

  it('accepts an empty conversation as present', () => {
    const evalCase: EvalCase = {evalId: 'test_id', conversation: []};

    expect(validateEvalCase(evalCase)).toBe(evalCase);
  });

  it('accepts a conversation scenario', () => {
    const evalCase: EvalCase = {
      evalId: 'test_id',
      conversationScenario: SCENARIO,
    };

    expect(validateEvalCase(evalCase)).toBe(evalCase);
  });
});

describe('rubrics', () => {
  it('round-trips rubrics on an invocation and on the eval case', () => {
    const invocation: Invocation = {
      userContent: {role: 'user', parts: [{text: 'hi'}]},
      rubrics: [RUBRIC],
    };
    const evalCase: EvalCase = {
      evalId: 'case_1',
      conversation: [invocation],
      rubrics: [RUBRIC],
    };

    const roundTripped: EvalCase = JSON.parse(JSON.stringify(evalCase));

    expect(roundTripped.rubrics).toEqual([RUBRIC]);
    expect(roundTripped.conversation?.[0].rubrics).toEqual([RUBRIC]);
  });
});

describe('reading a validated eval case', () => {
  it('validates a recorded case and pairs its trajectory', () => {
    const evalCase: EvalCase = validateEvalCase({
      evalId: 'weather_case',
      conversation: [
        {
          userContent: {role: 'user', parts: [{text: 'weather in SFO?'}]},
          intermediateData: {
            toolUses: [{id: 'call1', name: 'get_weather', args: {city: 'SFO'}}],
            toolResponses: [
              {id: 'call1', name: 'get_weather', response: {f: 61}},
            ],
            intermediateResponses: [],
          },
        },
      ],
    });

    const [invocation] = evalCase.conversation ?? [];

    expect(getAllToolCallsWithResponses(invocation?.intermediateData)).toEqual([
      [
        {id: 'call1', name: 'get_weather', args: {city: 'SFO'}},
        {id: 'call1', name: 'get_weather', response: {f: 61}},
      ],
    ]);
  });
});

describe('type guards', () => {
  it('accepts the events shape and rejects the trajectory shape', () => {
    expect(isInvocationEvents(events())).toBe(true);
    expect(isInvocationEvents(recorded([SEARCH_CALL]))).toBe(false);
  });

  it('accepts the trajectory shape and rejects the events shape', () => {
    expect(isIntermediateData(recorded([SEARCH_CALL]))).toBe(true);
    expect(isIntermediateData(events())).toBe(false);
  });

  it('rejects a value carrying both keys as the trajectory shape', () => {
    expect(isIntermediateData({invocationEvents: [], toolUses: []})).toBe(
      false,
    );
  });

  it('rejects values that are neither shape', () => {
    for (const value of ['a string', {}, [], null, 7]) {
      expect(isInvocationEvents(value)).toBe(false);
      expect(isIntermediateData(value)).toBe(false);
    }
  });
});
