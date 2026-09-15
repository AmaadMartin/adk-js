/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/evaluation/test_llm_as_judge_utils.py`, covering the four
 * helpers this change adds. Each `it()` keeps the Python test name, so the two
 * suites stay greppable against each other.
 */

import {
  AppDetails,
  getAverageRubricScore,
  getToolCallsAndResponsesAsJsonStr,
  getToolDeclarationsAsJsonStr,
  IntermediateData,
  InvocationEvents,
  RubricScore,
} from '@google/adk';
import {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';

const NO_TOOL_CALLS_TEXT = 'No intermediate steps were taken.';

function createIntermediateData(
  partial: Partial<IntermediateData>,
): IntermediateData {
  return {
    toolUses: [],
    toolResponses: [],
    intermediateResponses: [],
    ...partial,
  };
}

describe('getAverageRubricScore', () => {
  it('test_get_average_rubric_score_with_empty_list', () => {
    expect(getAverageRubricScore([])).toBeUndefined();
  });

  it('test_get_average_rubric_score_with_all_none_scores', () => {
    const rubricScores: RubricScore[] = [{rubricId: '1'}, {rubricId: '2'}];

    expect(getAverageRubricScore(rubricScores)).toBeUndefined();
  });

  it('test_get_average_rubric_score_with_single_score', () => {
    expect(getAverageRubricScore([{rubricId: '1', score: 0.8}])).toBe(0.8);
  });

  it('test_get_average_rubric_score_with_multiple_scores', () => {
    const rubricScores: RubricScore[] = [
      {rubricId: '1', score: 0.8},
      {rubricId: '2', score: 0.6},
    ];

    expect(getAverageRubricScore(rubricScores)).toBeCloseTo(0.7);
  });

  it('test_get_average_rubric_score_with_mixed_scores', () => {
    const rubricScores: RubricScore[] = [
      {rubricId: '1', score: 0.8},
      {rubricId: '2'},
      {rubricId: '3', score: 0.6},
    ];

    expect(getAverageRubricScore(rubricScores)).toBeCloseTo(0.7);
  });
});

describe('getToolDeclarationsAsJsonStr', () => {
  it('test_get_tool_declarations_as_json_str_with_no_agents', () => {
    const appDetails: AppDetails = {agentDetails: {}};

    expect(JSON.parse(getToolDeclarationsAsJsonStr(appDetails))).toEqual({
      tool_declarations: {},
    });
  });

  it('test_get_tool_declarations_as_json_str_with_agent_no_tools', () => {
    const appDetails: AppDetails = {
      agentDetails: {agent1: {name: 'agent1', toolDeclarations: []}},
    };

    expect(JSON.parse(getToolDeclarationsAsJsonStr(appDetails))).toEqual({
      tool_declarations: {agent1: []},
    });
  });

  it('test_get_tool_declarations_as_json_str_with_agent_with_tools', () => {
    const tool1: Tool = {
      functionDeclarations: [
        {name: 'test_func', description: 'A test function.'},
      ],
    };
    const appDetails: AppDetails = {
      agentDetails: {agent1: {name: 'agent1', toolDeclarations: [tool1]}},
    };

    expect(JSON.parse(getToolDeclarationsAsJsonStr(appDetails))).toEqual({
      tool_declarations: {
        agent1: [
          {
            function_declarations: [
              {name: 'test_func', description: 'A test function.'},
            ],
          },
        ],
      },
    });
  });

  it('test_get_tool_declarations_as_json_str_with_multiple_agents', () => {
    const tool1: Tool = {
      functionDeclarations: [
        {name: 'test_func1', description: 'A test function 1.'},
      ],
    };
    const appDetails: AppDetails = {
      agentDetails: {
        agent1: {name: 'agent1', toolDeclarations: [tool1]},
        agent2: {name: 'agent2', toolDeclarations: []},
      },
    };

    expect(JSON.parse(getToolDeclarationsAsJsonStr(appDetails))).toEqual({
      tool_declarations: {
        agent1: [
          {
            function_declarations: [
              {name: 'test_func1', description: 'A test function 1.'},
            ],
          },
        ],
        agent2: [],
      },
    });
  });

  it('keeps an agent name that reads as camelCase', () => {
    const appDetails: AppDetails = {
      agentDetails: {weatherAgent: {name: 'weatherAgent'}},
    };

    expect(JSON.parse(getToolDeclarationsAsJsonStr(appDetails))).toEqual({
      tool_declarations: {weatherAgent: []},
    });
  });
});

describe('getToolCallsAndResponsesAsJsonStr', () => {
  it('test_get_tool_calls_and_responses_as_json_str_with_none', () => {
    expect(getToolCallsAndResponsesAsJsonStr(undefined)).toBe(
      NO_TOOL_CALLS_TEXT,
    );
  });

  it('test_get_tool_calls_and_responses_as_json_str_with_intermediate_data_no_tools', () => {
    expect(getToolCallsAndResponsesAsJsonStr(createIntermediateData({}))).toBe(
      NO_TOOL_CALLS_TEXT,
    );
    expect(getToolCallsAndResponsesAsJsonStr({invocationEvents: []})).toBe(
      NO_TOOL_CALLS_TEXT,
    );
  });

  it('test_get_tool_calls_and_responses_as_json_str_with_invocation_events_multiple_calls', () => {
    const intermediateData: InvocationEvents = {
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
      ],
    };

    expect(
      JSON.parse(getToolCallsAndResponsesAsJsonStr(intermediateData)),
    ).toEqual({
      tool_calls_and_response: [
        {
          step: 0,
          tool_call: {name: 'func1', args: {}, id: 'call1'},
          tool_response: {
            name: 'func1',
            response: {status: 'ok'},
            id: 'call1',
          },
        },
        {
          step: 1,
          tool_call: {name: 'func2', args: {}, id: 'call2'},
          tool_response: 'None',
        },
      ],
    });
  });

  it('keeps the spelling of an argument the agent chose', () => {
    const intermediateData = createIntermediateData({
      toolUses: [{name: 'func1', args: {cityName: 'Seattle'}, id: 'call1'}],
    });

    expect(
      JSON.parse(getToolCallsAndResponsesAsJsonStr(intermediateData)),
    ).toEqual({
      tool_calls_and_response: [
        {
          step: 0,
          tool_call: {name: 'func1', args: {cityName: 'Seattle'}, id: 'call1'},
          tool_response: 'None',
        },
      ],
    });
  });
});
