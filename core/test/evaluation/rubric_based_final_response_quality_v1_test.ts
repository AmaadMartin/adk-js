/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AppDetailsSchema,
  BaseLlm,
  EvalStatus,
  InvocationSchema,
  LLMRegistry,
  LlmResponse,
  PrebuiltMetrics,
  Rubric,
  RubricBasedFinalResponseQualityV1Evaluator,
  RubricsBasedCriterionSchema,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

class MockJudge extends BaseLlm {
  constructor(private readonly response: LlmResponse) {
    super({model: 'mock-judge'});
  }
  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield this.response;
  }
  override connect(): Promise<never> {
    throw new Error('not implemented');
  }
}

const RUBRICS: Rubric[] = [
  {rubricId: '1', rubricContent: {textProperty: 'Is the response good?'}},
  {rubricId: '2', rubricContent: {textProperty: 'Is the response bad?'}},
];

function makeEvaluator(
  response: LlmResponse = {content: {parts: [{text: 'unused'}]}},
): RubricBasedFinalResponseQualityV1Evaluator {
  vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(new MockJudge(response));
  return new RubricBasedFinalResponseQualityV1Evaluator({
    metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
    threshold: 0.5,
    criterion: RubricsBasedCriterionSchema.parse({
      threshold: 0.5,
      rubrics: RUBRICS,
      judgeModelOptions: {numSamples: 3},
    }),
  });
}

describe('RubricBasedFinalResponseQualityV1Evaluator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats a prompt for a basic invocation', () => {
    const evaluator = makeEvaluator();
    const prompt = evaluator.formatAutoRaterPrompt(
      InvocationSchema.parse({
        userContent: {parts: [{text: 'User input here.'}]},
        finalResponse: {parts: [{text: 'Final agent response.'}]},
      }),
    );
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

  it('formats a prompt with app details', () => {
    const evaluator = makeEvaluator();
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {
        agent1: {
          name: 'agent1',
          instructions: 'This is an agent instruction.',
          toolDeclarations: [
            {
              functionDeclarations: [
                {name: 'test_func', description: 'A test function.'},
              ],
            },
          ],
        },
      },
    });
    const prompt = evaluator.formatAutoRaterPrompt(
      InvocationSchema.parse({
        userContent: {parts: [{text: 'User input here.'}]},
        finalResponse: {parts: [{text: 'Final agent response.'}]},
        appDetails,
        intermediateData: {
          invocationEvents: [{author: 'agent1', content: undefined}],
        },
      }),
    );
    expect(prompt).toContain('This is an agent instruction.');
    expect(prompt).toContain('"name": "test_func"');
    expect(prompt).toContain('"description": "A test function."');
  });

  it('formats a prompt with intermediate tool data', () => {
    const evaluator = makeEvaluator();
    const prompt = evaluator.formatAutoRaterPrompt(
      InvocationSchema.parse({
        userContent: {parts: [{text: 'User input here.'}]},
        finalResponse: {parts: [{text: 'Final agent response.'}]},
        intermediateData: {
          toolUses: [{name: 'test_func', args: {arg1: 'val1'}, id: 'call1'}],
          toolResponses: [
            {name: 'test_func', response: {result: 'ok'}, id: 'call1'},
          ],
        },
      }),
    );
    expect(prompt).toContain('"step": 0');
    expect(prompt).toContain('"toolCall":');
    expect(prompt).toContain('"name": "test_func"');
    expect(prompt).toContain('"toolResponse":');
    expect(prompt).toContain('"result": "ok"');
  });

  it('formats a prompt with app details but no tools', () => {
    const evaluator = makeEvaluator();
    const appDetails = AppDetailsSchema.parse({
      agentDetails: {agent1: {name: 'agent1', toolDeclarations: []}},
    });
    const prompt = evaluator.formatAutoRaterPrompt(
      InvocationSchema.parse({
        userContent: {parts: [{text: 'User input here.'}]},
        finalResponse: {parts: [{text: 'Final agent response.'}]},
        appDetails,
      }),
    );
    expect(prompt).toContain('"toolDeclarations": {\n    "agent1": []\n  }');
  });

  it('reports no intermediate steps when tool data is empty', () => {
    const evaluator = makeEvaluator();
    const prompt = evaluator.formatAutoRaterPrompt(
      InvocationSchema.parse({
        userContent: {parts: [{text: 'User input here.'}]},
        finalResponse: {parts: [{text: 'Final agent response.'}]},
        intermediateData: {toolUses: [], toolResponses: []},
      }),
    );
    expect(prompt).toContain('No intermediate steps were taken.');
  });

  it('renders empty text for a missing user prompt and final response', () => {
    const evaluator = makeEvaluator();
    const prompt = evaluator.formatAutoRaterPrompt(
      InvocationSchema.parse({userContent: {parts: []}}),
    );
    expect(prompt).toContain('<main_prompt>\n  \n  </main_prompt>');
    expect(prompt).toContain('<final_answer>\n  \n  </final_answer>');
  });

  it('scores end-to-end with a mock judge', async () => {
    const response: LlmResponse = {
      content: {
        parts: [
          {
            text: `ID: 1
Property: Is the response good?
Rationale: good
Verdict: yes

ID: 2
Property: Is the response bad?
Rationale: bad
Verdict: no
`,
          },
        ],
      },
    };
    const evaluator = makeEvaluator(response);
    const result = await evaluator.evaluateInvocations([
      InvocationSchema.parse({
        userContent: {parts: [{text: 'User input here.'}]},
        finalResponse: {parts: [{text: 'Final agent response.'}]},
      }),
    ]);
    expect(result.overallScore).toBeCloseTo(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.overallRubricScores).toHaveLength(2);
  });
});
