/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AutoRaterScore,
  BaseCriterionSchema,
  BaseLlm,
  EvalStatus,
  FinalResponseMatchV2Evaluator,
  Invocation,
  InvocationSchema,
  Label,
  LLMRegistry,
  LlmResponse,
  parseCritique,
  PerInvocationResult,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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

/** Exposes the protected template for injection, mirroring the adk-python test. */
class TestableFinalResponseMatchV2Evaluator extends FinalResponseMatchV2Evaluator {
  setTemplate(template: string): void {
    this.autoRaterPromptTemplate = template;
  }
}

function createTestTemplate(): string {
  return `
This is a test template.

{{
  "User prompt": {prompt},
  "Agent response": {response},
  "Reference response": {golden_response},
}}

The answer should be a json alone which follows the json structure below:
{{
  "is_the_agent_response_valid": [valid or invalid],
  "reasoning":
}}
`;
}

function createTestEvaluator(
  threshold: number,
  includeIntermediateResponsesInFinal = false,
): TestableFinalResponseMatchV2Evaluator {
  const evaluator = new TestableFinalResponseMatchV2Evaluator({
    metricName: 'final_response_match_v2',
    threshold,
    criterion: BaseCriterionSchema.parse({
      threshold: 0.5,
      includeIntermediateResponsesInFinal,
    }),
  });
  evaluator.setTemplate(createTestTemplate());
  return evaluator;
}

function createTestInvocations(
  candidate: string,
  reference: string,
): [Invocation, Invocation] {
  const actual = InvocationSchema.parse({
    userContent: {parts: [{text: 'This is a test query.'}], role: 'user'},
    finalResponse: {parts: [{text: candidate}], role: 'model'},
  });
  const expected = InvocationSchema.parse({
    userContent: {parts: [{text: 'This is a test query.'}], role: 'user'},
    finalResponse: {parts: [{text: reference}], role: 'model'},
  });
  return [actual, expected];
}

function withIntermediateText(
  invocation: Invocation,
  text: string,
): Invocation {
  return {
    ...invocation,
    intermediateData: {
      invocationEvents: [
        {author: 'agent', content: {parts: [{text}], role: 'model'}},
      ],
    },
  };
}

function llmResponseWithText(text: string): LlmResponse {
  return {content: {parts: [{text}], role: 'model'}};
}

function perInvocationResult(
  score: number | undefined,
  evalStatus: EvalStatus,
): PerInvocationResult {
  const [actualInvocation, expectedInvocation] = createTestInvocations(
    'candidate text',
    'reference text',
  );
  return {actualInvocation, expectedInvocation, score, evalStatus};
}

describe('parseCritique', () => {
  it.each([
    `\`\`\`json
  {
    "is_the_agent_response_valid_or_invalid": "valid",
    "reasoning": "The response is valid."
  }
  \`\`\``,
    `\`\`\`json
  {
    "is_the_agent_response_valid": "undefined label",
  }
  \`\`\``,
    '{"is_the_agent_response_valid": "maybe"}',
  ])('returns NOT_FOUND for %#', (responseText) => {
    expect(parseCritique(responseText)).toBe(Label.NOT_FOUND);
  });

  it('treats a non-true "..._invalid" label as valid', () => {
    expect(parseCritique('{"is_the_agent_response_invalid": "false"}')).toBe(
      Label.VALID,
    );
  });

  it.each([
    `\`\`\`json
  {
    "is_the_agent_response_valid": "valid",
    "reasoning": "The response is valid."
  }
  \`\`\``,
    `\`\`\`json
  {
    "is_the_agent_response_valid": ["valid"],
    "reasoning": "The response is valid."
  }
  \`\`\``,
    `\`\`\`json
  {
    "is_the_agent_response_valid":
    [ "valid
"],
    "reasoning": "The response is valid."
  }
  \`\`\``,
  ])('returns VALID for %#', (responseText) => {
    expect(parseCritique(responseText)).toBe(Label.VALID);
  });

  it.each([
    `\`\`\`json
  {
    "is_the_agent_response_invalid": "invalid",
    "reasoning": "The response is invalid."
  }
  \`\`\``,
    `\`\`\`json
  {
    "is_the_agent_response_invalid": ["invalid"],
    "reasoning": "The response is invalid."
  }
  \`\`\``,
    `\`\`\`json
  {
    "is_the_agent_response_invalid":
    [ "invalid
"],
    "reasoning": "The response is invalid."
  }
  \`\`\``,
  ])('returns INVALID for %#', (responseText) => {
    expect(parseCritique(responseText)).toBe(Label.INVALID);
  });
});

describe('FinalResponseMatchV2Evaluator', () => {
  beforeEach(() => {
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(
      new MockJudge(llmResponseWithText('unused')),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('formats the auto-rater prompt', () => {
    const evaluator = createTestEvaluator(0.8);
    const [actual, expected] = createTestInvocations(
      'candidate text',
      'reference text',
    );
    expect(evaluator.formatAutoRaterPrompt(actual, expected)).toBe(`
This is a test template.

{
  "User prompt": This is a test query.,
  "Agent response": candidate text,
  "Reference response": reference text,
}

The answer should be a json alone which follows the json structure below:
{
  "is_the_agent_response_valid": [valid or invalid],
  "reasoning":
}
`);
  });

  it('uses empty text for a missing final response', () => {
    const evaluator = createTestEvaluator(0.8);
    const actual = InvocationSchema.parse({
      userContent: {parts: [{text: 'This is a test query.'}], role: 'user'},
    });
    const expected = InvocationSchema.parse({
      userContent: {parts: [{text: 'This is a test query.'}], role: 'user'},
    });
    const prompt = evaluator.formatAutoRaterPrompt(actual, expected);
    expect(prompt).not.toContain('None');
    expect(prompt).toContain('"Agent response": ,');
    expect(prompt).toContain('"Reference response": ,');
  });

  it('ignores intermediate responses by default', () => {
    const evaluator = createTestEvaluator(0.8);
    let [actual, expected] = createTestInvocations(
      'candidate final',
      'reference final',
    );
    actual = withIntermediateText(actual, 'candidate intro');
    expected = withIntermediateText(expected, 'reference intro');
    const prompt = evaluator.formatAutoRaterPrompt(actual, expected);
    expect(prompt).toContain('candidate final');
    expect(prompt).toContain('reference final');
    expect(prompt).not.toContain('candidate intro');
    expect(prompt).not.toContain('reference intro');
  });

  it('includes intermediate responses when enabled', () => {
    const evaluator = createTestEvaluator(0.8, true);
    let [actual, expected] = createTestInvocations(
      'candidate final',
      'reference final',
    );
    actual = withIntermediateText(actual, 'candidate intro');
    expected = withIntermediateText(expected, 'reference intro');
    const prompt = evaluator.formatAutoRaterPrompt(actual, expected);
    expect(prompt).toContain('candidate intro\ncandidate final');
    expect(prompt).toContain('reference intro\nreference final');
  });

  it('throws when the expected invocation is missing', () => {
    const evaluator = createTestEvaluator(0.8);
    const [actual] = createTestInvocations('candidate', 'reference');
    expect(() => evaluator.formatAutoRaterPrompt(actual, undefined)).toThrow(
      /expectedInvocation is required/,
    );
  });

  it('uses empty text for a missing user prompt', () => {
    const evaluator = createTestEvaluator(0.8);
    const actual = InvocationSchema.parse({
      userContent: {parts: [{text: 'q'}], role: 'user'},
      finalResponse: {parts: [{text: 'a'}], role: 'model'},
    });
    const expected = InvocationSchema.parse({
      userContent: {parts: []},
      finalResponse: {parts: [{text: 'r'}], role: 'model'},
    });
    expect(evaluator.formatAutoRaterPrompt(actual, expected)).toContain(
      '"User prompt": ,',
    );
  });

  it('throws when actual and expected invocation counts differ', async () => {
    const evaluator = createTestEvaluator(0.5);
    const [actual, other] = createTestInvocations('a', 'b');
    await expect(
      evaluator.evaluateInvocations([actual, other], [actual]),
    ).rejects.toThrow(/same length/);
  });

  it.each<[string, AutoRaterScore]>([
    [
      `\`\`\`json
{
  "is_the_agent_response_valid": "valid",
  "reasoning": "The response is valid."
}
\`\`\``,
      {score: 1.0},
    ],
    [
      `\`\`\`json
{
  "is_the_agent_response_valid": "invalid",
  "reasoning": "The response is invalid."
}
\`\`\``,
      {score: 0.0},
    ],
    ['invalid json', {}],
    ['{}', {}],
  ])('converts an auto-rater response to a score (%#)', (text, expected) => {
    const evaluator = createTestEvaluator(0.8);
    expect(
      evaluator.convertAutoRaterResponseToScore(llmResponseWithText(text)),
    ).toEqual(expected);
  });

  it('converts a response with no content to an empty score', () => {
    const evaluator = createTestEvaluator(0.8);
    expect(
      evaluator.convertAutoRaterResponseToScore({content: undefined}),
    ).toEqual({});
  });

  it('aggregates per-invocation samples: none evaluated returns the first sample', () => {
    const evaluator = createTestEvaluator(0.5);
    const samples = [
      perInvocationResult(undefined, EvalStatus.NOT_EVALUATED),
      perInvocationResult(undefined, EvalStatus.NOT_EVALUATED),
    ];
    expect(evaluator.aggregatePerInvocationSamples(samples)).toBe(samples[0]);
  });

  it('aggregates per-invocation samples: majority valid', () => {
    const evaluator = createTestEvaluator(0.5);
    const samples = [
      perInvocationResult(1.0, EvalStatus.PASSED),
      perInvocationResult(1.0, EvalStatus.PASSED),
      perInvocationResult(0.0, EvalStatus.FAILED),
      perInvocationResult(0.0, EvalStatus.FAILED),
      perInvocationResult(1.0, EvalStatus.PASSED),
      perInvocationResult(1.0, EvalStatus.NOT_EVALUATED),
      perInvocationResult(undefined, EvalStatus.NOT_EVALUATED),
      perInvocationResult(0.0, EvalStatus.NOT_EVALUATED),
    ];
    const result = evaluator.aggregatePerInvocationSamples(samples);
    expect(result.score).toBe(1.0);
    expect(result.evalStatus).toBe(EvalStatus.PASSED);
  });

  it('aggregates per-invocation samples: tie prefers invalid', () => {
    const evaluator = createTestEvaluator(0.5);
    const samples = [
      perInvocationResult(0.0, EvalStatus.FAILED),
      perInvocationResult(1.0, EvalStatus.PASSED),
      perInvocationResult(0.0, EvalStatus.FAILED),
      perInvocationResult(0.0, EvalStatus.FAILED),
      perInvocationResult(1.0, EvalStatus.PASSED),
      perInvocationResult(1.0, EvalStatus.PASSED),
      perInvocationResult(1.0, EvalStatus.NOT_EVALUATED),
      perInvocationResult(undefined, EvalStatus.NOT_EVALUATED),
      perInvocationResult(0.0, EvalStatus.NOT_EVALUATED),
    ];
    const result = evaluator.aggregatePerInvocationSamples(samples);
    expect(result.score).toBe(0.0);
    expect(result.evalStatus).toBe(EvalStatus.FAILED);
  });

  it('aggregates invocation results into a fraction of valid', () => {
    const evaluator = createTestEvaluator(0.5);
    const results = [
      perInvocationResult(1.0, EvalStatus.PASSED),
      perInvocationResult(1.0, EvalStatus.PASSED),
      perInvocationResult(0.0, EvalStatus.FAILED),
      perInvocationResult(0.0, EvalStatus.FAILED),
      perInvocationResult(undefined, EvalStatus.PASSED),
      perInvocationResult(100.0, EvalStatus.NOT_EVALUATED),
      perInvocationResult(undefined, EvalStatus.NOT_EVALUATED),
    ];
    const aggregated = evaluator.aggregateInvocationResults(results);
    expect(aggregated.overallScore).toBe(0.5);
    expect(aggregated.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('aggregates invocation results with none evaluated', () => {
    const evaluator = createTestEvaluator(0.5);
    const results = [
      perInvocationResult(undefined, EvalStatus.NOT_EVALUATED),
      perInvocationResult(1.0, EvalStatus.NOT_EVALUATED),
    ];
    const aggregated = evaluator.aggregateInvocationResults(results);
    expect(aggregated.overallScore).toBeUndefined();
    expect(aggregated.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(aggregated.perInvocationResults).toEqual(results);
  });

  it('throws from evaluateInvocations when expected invocations are missing', async () => {
    const evaluator = createTestEvaluator(0.5);
    const [actual] = createTestInvocations('candidate', 'reference');
    await expect(evaluator.evaluateInvocations([actual])).rejects.toThrow(
      /expectedInvocations is needed/,
    );
  });

  it('evaluates end-to-end with a mock judge (no template override)', async () => {
    vi.restoreAllMocks();
    vi.spyOn(LLMRegistry, 'newLlm').mockReturnValue(
      new MockJudge(
        llmResponseWithText('{"is_the_agent_response_valid": "valid"}'),
      ),
    );
    const evaluator = new FinalResponseMatchV2Evaluator({
      metricName: 'final_response_match_v2',
      threshold: 0.5,
      criterion: BaseCriterionSchema.parse({threshold: 0.5}),
    });
    const [actual, expected] = createTestInvocations(
      'candidate text',
      'reference text',
    );
    const result = await evaluator.evaluateInvocations([actual], [expected]);
    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults).toHaveLength(1);
  });
});
