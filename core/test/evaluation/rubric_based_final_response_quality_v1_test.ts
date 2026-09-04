/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/evaluation/test_rubric_based_final_response_quality_v1.py`.
 * Each `it()` keeps the Python test name, so the two suites stay greppable
 * against each other.
 */

import {
  AppDetails,
  EvalMetric,
  InputValidationError,
  IntermediateData,
  Invocation,
  PrebuiltMetrics,
  Rubric,
  RubricBasedFinalResponseQualityV1Evaluator,
  parseRubricsBasedCriterion,
} from '@google/adk';
import {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {FakeJudgeLlm} from './fake_judge_llm.js';

const RUBRICS: Rubric[] = [
  {rubricId: '1', rubricContent: {textProperty: 'Is the response good?'}},
  {rubricId: '2', rubricContent: {textProperty: 'Is the response bad?'}},
];

function createEvaluator(): RubricBasedFinalResponseQualityV1Evaluator {
  const evalMetric: EvalMetric = {
    metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
    threshold: 0.5,
    criterion: {
      threshold: 0.5,
      rubrics: RUBRICS,
      judgeModelOptions: {numSamples: 3},
    },
  };
  return new RubricBasedFinalResponseQualityV1Evaluator(
    evalMetric,
    new FakeJudgeLlm([{silent: true}]),
  );
}

function createInvocation(partial: Partial<Invocation> = {}): Invocation {
  return {
    userContent: {parts: [{text: 'User input here.'}]},
    finalResponse: {parts: [{text: 'Final agent response.'}]},
    ...partial,
  };
}

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

describe('RubricBasedFinalResponseQualityV1Evaluator', () => {
  it('test_format_auto_rater_prompt_with_basic_invocation', () => {
    const prompt = createEvaluator().formatAutoRaterPrompt(createInvocation());

    expect(prompt).toContain('User input here.');
    expect(prompt).toContain('Final agent response.');
    expect(prompt).toContain('Is the response good?');
    expect(prompt).toContain('Is the response bad?');
    expect(prompt).toContain(
      '<developer_instructions>\n  \n  </developer_instructions>',
    );
    expect(prompt).toContain(
      '<available_tools>\n  Agent has no tools.\n  </available_tools>',
    );
    expect(prompt).toContain(
      '<response_steps>\n  No intermediate steps were taken.\n  </response_steps>',
    );
  });

  it('test_format_auto_rater_prompt_with_app_details', () => {
    const tool: Tool = {
      functionDeclarations: [
        {name: 'test_func', description: 'A test function.'},
      ],
    };
    const appDetails: AppDetails = {
      agentDetails: {
        agent1: {
          name: 'agent1',
          instructions: 'This is an agent instruction.',
          toolDeclarations: [tool],
        },
      },
    };

    const prompt = createEvaluator().formatAutoRaterPrompt(
      createInvocation({
        appDetails,
        intermediateData: {invocationEvents: [{author: 'agent1'}]},
      }),
    );

    expect(prompt).toContain('This is an agent instruction.');
    expect(prompt).toContain('"name": "test_func"');
    expect(prompt).toContain('"description": "A test function."');
  });

  it('test_format_auto_rater_prompt_with_intermediate_data', () => {
    const intermediateData = createIntermediateData({
      toolUses: [{name: 'test_func', args: {arg1: 'val1'}, id: 'call1'}],
      toolResponses: [
        {name: 'test_func', response: {result: 'ok'}, id: 'call1'},
      ],
    });

    const prompt = createEvaluator().formatAutoRaterPrompt(
      createInvocation({intermediateData}),
    );

    expect(prompt).toContain('"step": 0');
    expect(prompt).toContain('"tool_call":');
    expect(prompt).toContain('"name": "test_func"');
    expect(prompt).toContain('"tool_response":');
    expect(prompt).toContain('"result": "ok"');
  });

  it('test_format_auto_rater_prompt_with_grounding_metadata', () => {
    const prompt = createEvaluator().formatAutoRaterPrompt(
      createInvocation({
        userContent: {parts: [{text: "What's new in AI?"}]},
        finalResponse: {parts: [{text: 'Here are sources.'}]},
        intermediateData: {
          invocationEvents: [
            {
              author: 'agent',
              groundingMetadata: {webSearchQueries: ['recent AI news']},
            },
          ],
        },
      }),
    );

    expect(prompt).toContain('<grounding_metadata>');
    expect(prompt).toContain('recent AI news');
    expect(prompt).toContain('model-supplied grounding metadata');
  });

  it('test_format_auto_rater_prompt_with_app_details_no_tools', () => {
    const appDetails: AppDetails = {
      agentDetails: {agent1: {name: 'agent1', toolDeclarations: []}},
    };

    const prompt = createEvaluator().formatAutoRaterPrompt(
      createInvocation({appDetails}),
    );

    expect(prompt).toContain('"tool_declarations": {\n    "agent1": []\n  }');
  });

  it('test_format_auto_rater_prompt_with_intermediate_data_no_tools', () => {
    const prompt = createEvaluator().formatAutoRaterPrompt(
      createInvocation({intermediateData: createIntermediateData({})}),
    );

    expect(prompt).toContain('No intermediate steps were taken.');
  });

  it('test_format_auto_rater_prompt_with_app_details_empty_invocation_events', () => {
    // An agent that declines a request without calling a tool records no
    // event, and its instructions must still reach the judge.
    const appDetails: AppDetails = {
      agentDetails: {
        my_agent: {
          name: 'my_agent',
          instructions:
            'Only answer questions about cooking. Decline all other requests.',
          toolDeclarations: [],
        },
      },
    };

    const prompt = createEvaluator().formatAutoRaterPrompt(
      createInvocation({
        userContent: {parts: [{text: 'What is the capital of France?'}]},
        finalResponse: {parts: [{text: 'I can only help with cooking.'}]},
        appDetails,
        intermediateData: {invocationEvents: []},
      }),
    );

    expect(prompt).toContain('Only answer questions about cooking.');
    expect(prompt).toContain('I can only help with cooking.');
  });

  it('test_format_auto_rater_prompt_with_app_details_no_intermediate_data', () => {
    const appDetails: AppDetails = {
      agentDetails: {
        my_agent: {
          name: 'my_agent',
          instructions: 'Agent instructions here.',
          toolDeclarations: [],
        },
      },
    };

    const prompt = createEvaluator().formatAutoRaterPrompt(
      createInvocation({appDetails}),
    );

    expect(prompt).toContain('Agent instructions here.');
  });
});

describe('RubricBasedFinalResponseQualityV1Evaluator prompt edge cases', () => {
  it('names the criterion type and rubric type it grades', () => {
    expect(parseRubricsBasedCriterion.criterionName).toBe(
      'RubricsBasedCriterion',
    );
    expect(RubricBasedFinalResponseQualityV1Evaluator.RUBRIC_TYPE).toBe(
      'FINAL_RESPONSE_QUALITY',
    );
  });

  it('grades an invocation rubric of its own type, and skips the others', () => {
    const prompt = createEvaluator().formatAutoRaterPrompt(
      createInvocation({
        rubrics: [
          {
            rubricId: '3',
            rubricContent: {textProperty: 'Is the answer grounded?'},
            type: 'FINAL_RESPONSE_QUALITY',
          },
          {
            rubricId: '4',
            rubricContent: {textProperty: 'Did the agent pick the tool?'},
            type: 'TOOL_USE_QUALITY',
          },
        ],
      }),
    );

    expect(prompt).toContain('*  [id: 3] Is the answer grounded?');
    expect(prompt).not.toContain('Did the agent pick the tool?');
  });

  it('rejects an app that does not declare the agent that answered', () => {
    const appDetails: AppDetails = {
      agentDetails: {agent1: {name: 'agent1'}},
    };

    expect(() =>
      createEvaluator().formatAutoRaterPrompt(
        createInvocation({
          appDetails,
          intermediateData: {invocationEvents: [{author: 'ghost_agent'}]},
        }),
      ),
    ).toThrow(
      new InputValidationError(
        '`ghost_agent` not found in the agentic system.',
      ),
    );
  });

  it('leaves the instructions empty when the app declares no agent', () => {
    const prompt = createEvaluator().formatAutoRaterPrompt(
      createInvocation({appDetails: {}}),
    );

    expect(prompt).toContain(
      '<developer_instructions>\n  \n  </developer_instructions>',
    );
    expect(prompt).toContain(
      '<available_tools>\n  {\n  "tool_declarations": {}\n}\n  </available_tools>',
    );
  });

  it('rejects an invocation that no rubric applies to', () => {
    const evalMetric: EvalMetric = {
      metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
      criterion: {threshold: 0.5, rubrics: []},
    };
    const evaluator = new RubricBasedFinalResponseQualityV1Evaluator(
      evalMetric,
      new FakeJudgeLlm([{silent: true}]),
    );

    expect(() => evaluator.formatAutoRaterPrompt(createInvocation())).toThrow(
      new InputValidationError('Rubrics are required.'),
    );
  });
});
