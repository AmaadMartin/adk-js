/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  FinalResponseMatchV2Evaluator,
  formatAutoRaterPrompt,
  InputValidationError,
  Invocation,
  Label,
  LlmAsAJudgeMetric,
  LlmResponse,
  parseCritique,
  PerInvocationResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {FakeJudgeLlm} from './fake_judge_llm.js';

const TEST_TEMPLATE = `
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

function createEvaluator(
  options: {includeIntermediateResponsesInFinal?: boolean} = {},
): FinalResponseMatchV2Evaluator {
  const evalMetric: LlmAsAJudgeMetric = {
    metricName: 'final_response_match_v2',
    threshold: 0.8,
    criterion: {
      threshold: 0.5,
      includeIntermediateResponsesInFinal:
        options.includeIntermediateResponsesInFinal,
    },
  };
  return new FinalResponseMatchV2Evaluator(
    evalMetric,
    new FakeJudgeLlm([{silent: true}]),
  );
}

function createInvocations(
  candidate: string,
  reference: string,
): [Invocation, Invocation] {
  return [createInvocation(candidate), createInvocation(reference)];
}

function createInvocation(finalResponse: string): Invocation {
  return {
    userContent: {role: 'user', parts: [{text: 'This is a test query.'}]},
    finalResponse: {role: 'model', parts: [{text: finalResponse}]},
  };
}

function addIntermediateEvent(invocation: Invocation, text: string): void {
  invocation.intermediateData = {
    invocationEvents: [
      {author: 'agent', content: {role: 'model', parts: [{text}]}},
    ],
  };
}

function createSample(
  score: number | undefined,
  evalStatus: EvalStatus,
): PerInvocationResult {
  const [actualInvocation, expectedInvocation] = createInvocations(
    'candidate text',
    'reference text',
  );
  return {actualInvocation, expectedInvocation, score, evalStatus};
}

function createCritique(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}};
}

describe('parseCritique', () => {
  it.each([
    '```json\n{\n  "is_the_agent_response_valid_or_invalid": "valid",\n  "reasoning": "The response is valid."\n}\n```',
    '```json\n{\n  "is_the_agent_response_valid": "undefined label",\n}\n```',
  ])('reports no label for %j', (responseText) => {
    expect(parseCritique(responseText)).toBe(Label.NOT_FOUND);
  });

  it.each([
    '```json\n{\n  "is_the_agent_response_valid": "valid",\n  "reasoning": "The response is valid."\n}\n```',
    '```json\n{\n  "is_the_agent_response_valid": ["valid"],\n  "reasoning": "The response is valid."\n}\n```',
    '```json\n{\n  "is_the_agent_response_valid":\n    [ "valid\n"],\n  "reasoning": "The response is valid."\n}\n```',
    '{"is_the_agent_response_valid": "true"}',
  ])('reports a valid response for %j', (responseText) => {
    expect(parseCritique(responseText)).toBe(Label.VALID);
  });

  it.each([
    '```json\n{\n  "is_the_agent_response_invalid": "invalid",\n  "reasoning": "The response is invalid."\n}\n```',
    '```json\n{\n  "is_the_agent_response_invalid": ["invalid"],\n  "reasoning": "The response is invalid."\n}\n```',
    '```json\n{\n  "is_the_agent_response_invalid":\n    [ "invalid\n"],\n  "reasoning": "The response is invalid."\n}\n```',
    '{"is_the_agent_response_invalid": "true"}',
  ])('reports an invalid response for %j', (responseText) => {
    expect(parseCritique(responseText)).toBe(Label.INVALID);
  });

  it.each(['partially_valid', 'partially', 'almost', 'false'])(
    'counts %j as an invalid response',
    (label) => {
      expect(parseCritique(`{"is_the_agent_response_valid": "${label}"}`)).toBe(
        Label.INVALID,
      );
    },
  );

  it('reports no label for a verdict it does not know', () => {
    expect(parseCritique('{"is_the_agent_response_valid": "maybe"}')).toBe(
      Label.NOT_FOUND,
    );
  });

  it('reports no label for a label that carries a space', () => {
    // The label pattern stops at whitespace, as adk-python's does, so a
    // two-word label never matches.
    expect(
      parseCritique('{"is_the_agent_response_valid": "partially valid"}'),
    ).toBe(Label.NOT_FOUND);
  });

  it('counts any other label on the inverted field as a valid response', () => {
    expect(parseCritique('{"is_the_agent_response_invalid": "false"}')).toBe(
      Label.VALID,
    );
  });
});

describe('formatAutoRaterPrompt', () => {
  it('fills the template and unescapes the braces', () => {
    const prompt = formatAutoRaterPrompt(TEST_TEMPLATE, {
      prompt: 'This is a test query.',
      response: 'candidate text',
      goldenResponse: 'reference text',
    });

    expect(prompt).toBe(`
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

  it('does not expand a substitution pattern the values carry', () => {
    const prompt = formatAutoRaterPrompt('response: {response}', {
      prompt: '',
      response: '$& $1 $`',
      goldenResponse: '',
    });

    expect(prompt).toBe('response: $& $1 $`');
  });
});

describe('FinalResponseMatchV2Evaluator', () => {
  it('rejects a metric that carries no criterion', () => {
    expect(
      () =>
        new FinalResponseMatchV2Evaluator({
          metricName: 'final_response_match_v2',
        }),
    ).toThrow(InputValidationError);
  });

  it('rejects a prompt with no reference invocation', () => {
    const evaluator = createEvaluator();
    const [actual] = createInvocations('candidate text', 'reference text');

    expect(() => evaluator.formatAutoRaterPrompt(actual)).toThrow(
      InputValidationError,
    );
  });

  it('fills the judge prompt with the two responses and the query', () => {
    const evaluator = createEvaluator();
    const [actual, expected] = createInvocations(
      'candidate text',
      'reference text',
    );

    const prompt = evaluator.formatAutoRaterPrompt(actual, expected);

    expect(prompt).toContain('"User prompt": This is a test query.,');
    expect(prompt).toContain('"Agent response": candidate text,');
    expect(prompt).toContain('"Reference response": reference text,');
  });

  it('uses empty text for a missing final response', () => {
    const evaluator = createEvaluator();
    const [actual, expected] = createInvocations(
      'candidate text',
      'reference text',
    );
    actual.finalResponse = undefined;
    expected.finalResponse = undefined;

    const prompt = evaluator.formatAutoRaterPrompt(actual, expected);

    expect(prompt).not.toContain('None');
    expect(prompt).not.toContain('undefined');
    expect(prompt).toContain('"Agent response": ,');
    expect(prompt).toContain('"Reference response": ,');
  });

  it('ignores the intermediate responses by default', () => {
    const evaluator = createEvaluator();
    const [actual, expected] = createInvocations(
      'candidate final',
      'reference final',
    );
    addIntermediateEvent(actual, 'candidate intro');
    addIntermediateEvent(expected, 'reference intro');

    const prompt = evaluator.formatAutoRaterPrompt(actual, expected);

    expect(prompt).toContain('candidate final');
    expect(prompt).toContain('reference final');
    expect(prompt).not.toContain('candidate intro');
    expect(prompt).not.toContain('reference intro');
  });

  it('reads the intermediate events when the criterion asks for them', () => {
    const evaluator = createEvaluator({
      includeIntermediateResponsesInFinal: true,
    });
    const [actual, expected] = createInvocations(
      'candidate final',
      'reference final',
    );
    addIntermediateEvent(actual, 'candidate intro');
    addIntermediateEvent(expected, 'reference intro');

    const prompt = evaluator.formatAutoRaterPrompt(actual, expected);

    expect(prompt).toContain('candidate intro\ncandidate final');
    expect(prompt).toContain('reference intro\nreference final');
  });

  it('reads the recorded intermediate responses when asked for them', () => {
    const evaluator = createEvaluator({
      includeIntermediateResponsesInFinal: true,
    });
    const [actual, expected] = createInvocations(
      'candidate final',
      'reference final',
    );
    actual.intermediateData = {
      toolUses: [],
      toolResponses: [],
      intermediateResponses: [
        ['agent', [{text: 'candidate intro'}]],
        ['agent', [{}]],
      ],
    };

    const prompt = evaluator.formatAutoRaterPrompt(actual, expected);

    expect(prompt).toContain(
      '"Agent response": candidate intro\ncandidate final,',
    );
    expect(prompt).toContain('"Reference response": reference final,');
  });

  it('reads only the intermediate text when the final response is missing', () => {
    const evaluator = createEvaluator({
      includeIntermediateResponsesInFinal: true,
    });
    const [actual, expected] = createInvocations(
      'candidate final',
      'reference final',
    );
    actual.finalResponse = undefined;
    addIntermediateEvent(actual, 'candidate intro');

    const prompt = evaluator.formatAutoRaterPrompt(actual, expected);

    expect(prompt).toContain('"Agent response": candidate intro,');
  });

  it.each([
    ['valid', 1],
    ['invalid', 0],
  ])('scores a %s critique as %d', (label, score) => {
    const evaluator = createEvaluator();
    const critique = createCritique(
      `\`\`\`json\n{\n  "is_the_agent_response_valid": "${label}",\n  "reasoning": "A reason."\n}\n\`\`\``,
    );

    expect(evaluator.convertAutoRaterResponseToScore(critique)).toBe(score);
  });

  it.each(['invalid json', '{}', ''])(
    'awards no score for the critique %j',
    (text) => {
      const evaluator = createEvaluator();

      expect(
        evaluator.convertAutoRaterResponseToScore(createCritique(text)),
      ).toBeUndefined();
    },
  );

  it('keeps the first sample when the judge scored none of them', () => {
    const evaluator = createEvaluator();
    const samples = [
      createSample(undefined, EvalStatus.NOT_EVALUATED),
      createSample(undefined, EvalStatus.NOT_EVALUATED),
    ];

    expect(evaluator.aggregatePerInvocationSamples(samples)).toBe(samples[0]);
  });

  it('takes the majority verdict over the samples', () => {
    const evaluator = createEvaluator();
    const samples = [
      createSample(1, EvalStatus.PASSED),
      createSample(1, EvalStatus.PASSED),
      createSample(0, EvalStatus.FAILED),
      createSample(0, EvalStatus.FAILED),
      createSample(1, EvalStatus.PASSED),
      createSample(1, EvalStatus.NOT_EVALUATED),
      createSample(undefined, EvalStatus.NOT_EVALUATED),
      createSample(0, EvalStatus.NOT_EVALUATED),
    ];

    const result = evaluator.aggregatePerInvocationSamples(samples);

    expect(result.score).toBe(1);
    expect(result.evalStatus).toBe(EvalStatus.PASSED);
  });

  it('counts a tie between the samples as invalid', () => {
    const evaluator = createEvaluator();
    const samples = [
      createSample(1, EvalStatus.PASSED),
      createSample(0, EvalStatus.FAILED),
    ];

    const result = evaluator.aggregatePerInvocationSamples(samples);

    expect(result.score).toBe(0);
    expect(result.evalStatus).toBe(EvalStatus.FAILED);
  });

  it('scores the fraction of the evaluated invocations that are valid', () => {
    const evaluator = createEvaluator();
    const results = [
      createSample(1, EvalStatus.PASSED),
      createSample(1, EvalStatus.PASSED),
      createSample(0, EvalStatus.FAILED),
      createSample(0, EvalStatus.FAILED),
      createSample(undefined, EvalStatus.PASSED),
      createSample(100, EvalStatus.NOT_EVALUATED),
      createSample(undefined, EvalStatus.NOT_EVALUATED),
    ];

    const result = evaluator.aggregateInvocationResults(results);

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('awards no overall score when nothing was evaluated', () => {
    const evaluator = createEvaluator();
    const results = [
      createSample(undefined, EvalStatus.NOT_EVALUATED),
      createSample(1, EvalStatus.NOT_EVALUATED),
    ];

    const result = evaluator.aggregateInvocationResults(results);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toBe(results);
  });

  it('fails an overall score below the threshold', () => {
    const evaluator = createEvaluator();
    const results = [
      createSample(1, EvalStatus.PASSED),
      createSample(0, EvalStatus.FAILED),
      createSample(0, EvalStatus.FAILED),
    ];

    const result = evaluator.aggregateInvocationResults(results);

    expect(result.overallScore).toBeCloseTo(1 / 3);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });
});
