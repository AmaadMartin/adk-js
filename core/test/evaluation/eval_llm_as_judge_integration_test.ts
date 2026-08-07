/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Mock-backed, end-to-end integration test: the only seam that is stubbed is the
// judge model resolved via LLMRegistry, so no live network calls are made. The
// evaluators are constructed and driven exactly as a consumer would via the
// public `@google/adk` entry point.

import {
  BaseCriterionSchema,
  BaseLlm,
  EvalStatus,
  FinalResponseMatchV2Evaluator,
  InvocationSchema,
  LLMRegistry,
  LlmResponse,
  PrebuiltMetrics,
  RubricBasedFinalResponseQualityV1Evaluator,
  RubricsBasedCriterionSchema,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

class ConstantJudge extends BaseLlm {
  constructor(private readonly text: string) {
    super({model: 'mock-judge'});
  }
  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {content: {parts: [{text: this.text}]}};
  }
  override connect(): Promise<never> {
    throw new Error('not implemented');
  }
}

describe('LLM-as-judge evaluators (integration)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scores final response match v2 end-to-end', async () => {
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(
      new ConstantJudge('{"is_the_agent_response_valid": "valid"}'),
    );
    const evaluator = new FinalResponseMatchV2Evaluator({
      metricName: PrebuiltMetrics.FINAL_RESPONSE_MATCH_V2,
      threshold: 0.8,
      criterion: BaseCriterionSchema.parse({threshold: 0.5}),
    });

    const actual = InvocationSchema.parse({
      userContent: {parts: [{text: 'What is 2 + 2?'}], role: 'user'},
      finalResponse: {parts: [{text: 'The answer is 4.'}], role: 'model'},
    });
    const expected = InvocationSchema.parse({
      userContent: {parts: [{text: 'What is 2 + 2?'}], role: 'user'},
      finalResponse: {parts: [{text: '4'}], role: 'model'},
    });

    const result = await evaluator.evaluateInvocations([actual], [expected]);
    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults).toHaveLength(1);
    expect(result.perInvocationResults[0].evalStatus).toBe(EvalStatus.PASSED);
  });

  it('scores rubric-based final response quality end-to-end', async () => {
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(
      new ConstantJudge(`ID: concise
Property: The response is concise.
Rationale: It is a single sentence.
Verdict: yes
`),
    );
    const evaluator = new RubricBasedFinalResponseQualityV1Evaluator({
      metricName: PrebuiltMetrics.RUBRIC_BASED_FINAL_RESPONSE_QUALITY_V1,
      threshold: 0.7,
      criterion: RubricsBasedCriterionSchema.parse({
        threshold: 0.7,
        judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 1},
        rubrics: [
          {
            rubricId: 'concise',
            rubricContent: {textProperty: 'The response is concise.'},
          },
        ],
      }),
    });

    const actual = InvocationSchema.parse({
      userContent: {parts: [{text: 'Summarize the weather.'}], role: 'user'},
      finalResponse: {parts: [{text: 'Sunny, 20C.'}], role: 'model'},
    });

    const result = await evaluator.evaluateInvocations([actual]);
    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.overallRubricScores).toHaveLength(1);
    expect(result.overallRubricScores?.[0].rubricId).toBe('concise');
  });
});
