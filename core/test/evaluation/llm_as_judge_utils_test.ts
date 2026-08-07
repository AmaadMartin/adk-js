/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentDetailsSchema,
  AppDetailsSchema,
  EvalStatus,
  getAllToolCalls,
  getAllToolResponses,
  getAverageRubricScore,
  getDeveloperInstructions,
  getEvalStatus,
  getTextFromContent,
  getToolCallsAndResponsesAsJsonStr,
  getToolDeclarationsAsJsonStr,
  getToolsByAgentName,
  IntermediateDataSchema,
  IntermediateDataType,
  InvocationEventsSchema,
  InvocationSchema,
  RubricScoreSchema,
} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';

describe('getTextFromContent', () => {
  it('returns undefined for undefined input', () => {
    expect(getTextFromContent(undefined)).toBeUndefined();
  });

  it('returns undefined for Content with no parts', () => {
    const content: Content = {parts: undefined};
    expect(getTextFromContent(content)).toBeUndefined();
  });

  it('returns undefined for an empty parts list', () => {
    expect(getTextFromContent({parts: []})).toBeUndefined();
  });

  it('returns an empty string for parts without text', () => {
    const content: Content = {parts: [{functionCall: {name: 'test_func'}}]};
    expect(getTextFromContent(content)).toBe('');
  });

  it('returns text for a single text part', () => {
    expect(getTextFromContent({parts: [{text: 'Hello'}]})).toBe('Hello');
  });

  it('joins multiple text parts with newlines', () => {
    const content: Content = {parts: [{text: 'Hello'}, {text: 'World'}]};
    expect(getTextFromContent(content)).toBe('Hello\nWorld');
  });

  it('ignores non-text parts when joining', () => {
    const content: Content = {
      parts: [
        {text: 'Hello'},
        {functionCall: {name: 'test_func'}},
        {text: 'World'},
      ],
    };
    expect(getTextFromContent(content)).toBe('Hello\nWorld');
  });

  it('handles an invocation with and without the intermediate-responses flag (events)', () => {
    const intermediateText = 'Let me check.';
    const finalResponseText = 'Done.';
    const invocation = InvocationSchema.parse({
      userContent: {parts: [{text: 'user'}]},
      intermediateData: {
        invocationEvents: [
          {author: 'agent', content: {parts: [{text: intermediateText}]}},
          {
            author: 'tool',
            content: {parts: [{functionCall: {name: 't'}}]},
          },
        ],
      },
      finalResponse: {parts: [{text: finalResponseText}]},
    });

    // Flag off (default): only the final response text is returned.
    expect(getTextFromContent(invocation)).toBe(finalResponseText);

    // Flag on: intermediate text is concatenated before the final response.
    expect(
      getTextFromContent(invocation, {
        includeIntermediateResponsesInFinal: true,
      }),
    ).toBe(`${intermediateText}\n${finalResponseText}`);
  });

  it('handles an invocation with legacy intermediate data', () => {
    const invocation = InvocationSchema.parse({
      userContent: {parts: [{text: 'user'}]},
      intermediateData: {
        intermediateResponses: [
          ['agent', [{text: 'legacy intro'}]],
          ['tool', [{functionCall: {name: 'lookup'}}]],
        ],
      },
      finalResponse: {parts: [{text: 'final answer'}]},
    });

    expect(getTextFromContent(invocation)).toBe('final answer');
    expect(
      getTextFromContent(invocation, {
        includeIntermediateResponsesInFinal: true,
      }),
    ).toBe('legacy intro\nfinal answer');
  });

  it('returns undefined when an invocation has no intermediate text and no final response (flag on)', () => {
    const invocation = InvocationSchema.parse({
      userContent: {parts: [{text: 'user'}]},
      intermediateData: {invocationEvents: []},
    });
    expect(
      getTextFromContent(invocation, {
        includeIntermediateResponsesInFinal: true,
      }),
    ).toBeUndefined();
  });
});

describe('getEvalStatus', () => {
  it('returns NOT_EVALUATED for an undefined score', () => {
    expect(getEvalStatus(undefined, 0.5)).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('returns PASSED when the score exceeds the threshold', () => {
    expect(getEvalStatus(0.8, 0.5)).toBe(EvalStatus.PASSED);
  });

  it('returns PASSED when the score equals the threshold', () => {
    expect(getEvalStatus(0.5, 0.5)).toBe(EvalStatus.PASSED);
  });

  it('returns FAILED when the score is below the threshold', () => {
    expect(getEvalStatus(0.4, 0.5)).toBe(EvalStatus.FAILED);
  });
});

describe('getAverageRubricScore', () => {
  it('returns undefined for an empty list', () => {
    expect(getAverageRubricScore([])).toBeUndefined();
  });

  it('returns undefined when all scores are undefined', () => {
    const rubricScores = [
      RubricScoreSchema.parse({rubricId: '1'}),
      RubricScoreSchema.parse({rubricId: '2'}),
    ];
    expect(getAverageRubricScore(rubricScores)).toBeUndefined();
  });

  it('returns the score for a single valid entry', () => {
    expect(
      getAverageRubricScore([
        RubricScoreSchema.parse({rubricId: '1', score: 0.8}),
      ]),
    ).toBe(0.8);
  });

  it('averages multiple valid scores', () => {
    const rubricScores = [
      RubricScoreSchema.parse({rubricId: '1', score: 0.8}),
      RubricScoreSchema.parse({rubricId: '2', score: 0.6}),
    ];
    expect(getAverageRubricScore(rubricScores)).toBeCloseTo(0.7);
  });

  it('averages only the present scores when mixed with undefined', () => {
    const rubricScores = [
      RubricScoreSchema.parse({rubricId: '1', score: 0.8}),
      RubricScoreSchema.parse({rubricId: '2'}),
      RubricScoreSchema.parse({rubricId: '3', score: 0.6}),
    ];
    expect(getAverageRubricScore(rubricScores)).toBeCloseTo(0.7);
  });
});

describe('getToolDeclarationsAsJsonStr', () => {
  it('serializes when there are no agents', () => {
    const appDetails = AppDetailsSchema.parse({agentDetails: {}});
    expect(JSON.parse(getToolDeclarationsAsJsonStr(appDetails))).toEqual({
      toolDeclarations: {},
    });
  });

  it('serializes an agent with no tools', () => {
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {
        agent1: AgentDetailsSchema.parse({
          name: 'agent1',
          toolDeclarations: [],
        }),
      },
    });
    expect(JSON.parse(getToolDeclarationsAsJsonStr(appDetails))).toEqual({
      toolDeclarations: {agent1: []},
    });
  });

  it('serializes an agent with tools', () => {
    const tool = {
      functionDeclarations: [
        {name: 'test_func', description: 'A test function.'},
      ],
    };
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {
        agent1: AgentDetailsSchema.parse({
          name: 'agent1',
          toolDeclarations: [tool],
        }),
      },
    });
    expect(JSON.parse(getToolDeclarationsAsJsonStr(appDetails))).toEqual({
      toolDeclarations: {agent1: [tool]},
    });
  });

  it('serializes multiple agents', () => {
    const tool = {
      functionDeclarations: [
        {name: 'test_func1', description: 'A test function 1.'},
      ],
    };
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {
        agent1: AgentDetailsSchema.parse({
          name: 'agent1',
          toolDeclarations: [tool],
        }),
        agent2: AgentDetailsSchema.parse({
          name: 'agent2',
          toolDeclarations: [],
        }),
      },
    });
    expect(JSON.parse(getToolDeclarationsAsJsonStr(appDetails))).toEqual({
      toolDeclarations: {agent1: [tool], agent2: []},
    });
  });
});

describe('app_details helpers', () => {
  it('returns developer instructions for a known agent', () => {
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {
        agent1: {name: 'agent1', instructions: 'Be helpful.'},
      },
    });
    expect(getDeveloperInstructions(appDetails, 'agent1')).toBe('Be helpful.');
  });

  it('throws for an unknown agent', () => {
    const appDetails = AppDetailsSchema.parse({agentDetails: {}});
    expect(() => getDeveloperInstructions(appDetails, 'missing')).toThrow(
      /not found in the agentic system/,
    );
  });

  it('maps tools by agent name', () => {
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {
        agent1: {name: 'agent1', toolDeclarations: [{name: 't'}]},
      },
    });
    expect(getToolsByAgentName(appDetails)).toEqual({agent1: [{name: 't'}]});
  });
});

describe('getAllToolCalls / getAllToolResponses', () => {
  it('throw for an unsupported intermediate data shape', () => {
    // Deliberately pass a value that is neither IntermediateData nor
    // InvocationEvents to exercise the defensive guard.
    const bad = {} as unknown as IntermediateDataType;
    expect(() => getAllToolCalls(bad)).toThrow(/Unsupported type/);
    expect(() => getAllToolResponses(bad)).toThrow(/Unsupported type/);
  });
});

describe('getToolCallsAndResponsesAsJsonStr', () => {
  it('reports no steps for undefined intermediate data', () => {
    expect(getToolCallsAndResponsesAsJsonStr(undefined)).toBe(
      'No intermediate steps were taken.',
    );
  });

  it('reports no steps for empty intermediate data', () => {
    expect(
      getToolCallsAndResponsesAsJsonStr(
        IntermediateDataSchema.parse({toolUses: [], toolResponses: []}),
      ),
    ).toBe('No intermediate steps were taken.');
    expect(
      getToolCallsAndResponsesAsJsonStr(
        InvocationEventsSchema.parse({invocationEvents: []}),
      ),
    ).toBe('No intermediate steps were taken.');
  });

  it('serializes multiple tool calls, matching responses by id', () => {
    const intermediateData = InvocationEventsSchema.parse({
      invocationEvents: [
        {
          author: 'agent',
          content: {
            parts: [
              {functionCall: {name: 'func1', args: {}, id: 'call1'}},
              {functionCall: {name: 'func2', args: {}, id: 'call2'}},
            ],
          },
        },
        {
          author: 'tool',
          content: {
            parts: [
              {
                functionResponse: {
                  name: 'func1',
                  response: {status: 'ok'},
                  id: 'call1',
                },
              },
            ],
          },
        },
        // An event without content is skipped when collecting tool calls.
        {author: 'noop'},
      ],
    });
    expect(
      JSON.parse(getToolCallsAndResponsesAsJsonStr(intermediateData)),
    ).toEqual({
      toolCallsAndResponse: [
        {
          step: 0,
          toolCall: {name: 'func1', args: {}, id: 'call1'},
          toolResponse: {name: 'func1', response: {status: 'ok'}, id: 'call1'},
        },
        {
          step: 1,
          toolCall: {name: 'func2', args: {}, id: 'call2'},
          toolResponse: 'None',
        },
      ],
    });
  });
});
