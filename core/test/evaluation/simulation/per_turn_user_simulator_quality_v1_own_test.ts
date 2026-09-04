/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests written for adk-js, kept apart from the ported reference tests in
 * `per_turn_user_simulator_quality_v1_test.ts` so the ported set stays legible.
 */

import {
  BaseLlm,
  DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
  EvalStatus,
  InputValidationError,
  LLMRegistry,
  Label,
  PerTurnUserSimulatorQualityV1,
  type BaseLlmConnection,
  type ConversationScenario,
  type EvalMetric,
  type Invocation,
  type LlmResponse,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {DEFAULT_RETRY_ATTEMPTS} from '../../../src/evaluation/retry_options_utils.js';
import {
  aggregateConversationResults,
  aggregateSamples,
  convertLlmResponseToScore,
  evaluateFirstTurn,
  formatConversationHistory,
  formatJudgePrompt,
  parseIsValidLabel,
} from '../../../src/evaluation/simulation/per_turn_user_simulator_quality_v1.js';
import {FAKE_JUDGE_MODEL, FakeJudgeLlm} from '../fake_judge_llm.js';

const VALID_CRITIQUE = '{"is_valid": true}';
const REGISTERED_JUDGE_MODEL = 'registered-test-judge';
const INVALID_CRITIQUE = '{"is_valid": false}';

/** A judge the registry can build from a model name alone. */
class RegisteredJudgeLlm extends BaseLlm {
  static readonly supportedModels = [REGISTERED_JUDGE_MODEL];

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {content: {role: 'model', parts: [{text: VALID_CRITIQUE}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('RegisteredJudgeLlm does not support live connections.');
  }
}

const SCENARIO: ConversationScenario = {
  startingPrompt: 'first user prompt.',
  conversationPlan: 'test conversation plan',
};

function createInvocation(userText: string, modelText: string): Invocation {
  return {
    userContent: {parts: [{text: userText}], role: 'user'},
    finalResponse: {parts: [{text: modelText}], role: 'model'},
  };
}

/** A two-turn conversation whose first turn is the scenario's prompt. */
function createConversation(): Invocation[] {
  return [
    createInvocation(SCENARIO.startingPrompt, 'model 1.'),
    createInvocation('user 2.', 'model 2.'),
  ];
}

function createEvaluator(
  judgeModel: FakeJudgeLlm,
  criterion: EvalMetric['criterion'] = {threshold: 1.0, stopSignal: 'stop'},
): PerTurnUserSimulatorQualityV1 {
  return new PerTurnUserSimulatorQualityV1(
    {metricName: 'per_turn_user_simulator_quality_v1', criterion},
    {judgeModel},
  );
}

describe('PerTurnUserSimulatorQualityV1 criterion handling', () => {
  it('rejects a metric that names no criterion', () => {
    expect(
      () =>
        new PerTurnUserSimulatorQualityV1({
          metricName: 'per_turn_user_simulator_quality_v1',
          threshold: 1.0,
        }),
    ).toThrow(
      '`per_turn_user_simulator_quality_v1` metric expects a criterion of ' +
        'type `LlmBackedUserSimulatorCriterion`.',
    );
  });

  it('rejects an invalid criterion, keeping the schema error as the cause', () => {
    let thrown: unknown;
    try {
      new PerTurnUserSimulatorQualityV1({
        metricName: 'per_turn_user_simulator_quality_v1',
        criterion: {threshold: 1.0, judgeModelOptions: {parallelismLimit: 0}},
      });
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InputValidationError);
    expect((thrown as InputValidationError).message).toContain(
      '`LlmBackedUserSimulatorCriterion`',
    );
    expect((thrown as InputValidationError).cause).toBeInstanceOf(Error);
  });

  it('defaults the stop signal when the criterion names none', async () => {
    const judgeModel = new FakeJudgeLlm([{critique: VALID_CRITIQUE}]);
    const evaluator = createEvaluator(judgeModel, {
      threshold: 1.0,
      judgeModelOptions: {numSamples: 1},
    });

    await evaluator.evaluateInvocations(
      createConversation(),
      undefined,
      SCENARIO,
    );

    const stopSignalPrompt =
      judgeModel.requests.at(-1)?.contents[0].parts?.[0].text;
    expect(stopSignalPrompt).toContain(
      `# Generated User Response\n${DEFAULT_USER_SIMULATOR_STOP_SIGNAL}`,
    );
  });

  it('resolves the judge model through LLMRegistry when none is injected', async () => {
    LLMRegistry.register(RegisteredJudgeLlm);
    const evaluator = new PerTurnUserSimulatorQualityV1({
      metricName: 'per_turn_user_simulator_quality_v1',
      criterion: {
        threshold: 1.0,
        stopSignal: 'stop',
        judgeModelOptions: {
          judgeModel: REGISTERED_JUDGE_MODEL,
          numSamples: 1,
        },
      },
    });

    const result = await evaluator.evaluateInvocations(
      createConversation(),
      undefined,
      SCENARIO,
    );

    expect(result.overallScore).toBe(1.0);
  });
});

describe('PerTurnUserSimulatorQualityV1.evaluateInvocations', () => {
  it('rejects a call that supplies no conversation scenario', async () => {
    const evaluator = createEvaluator(new FakeJudgeLlm([{silent: true}]));

    await expect(
      evaluator.evaluateInvocations(createConversation()),
    ).rejects.toThrow('conversationScenario is needed by this metric.');
  });

  // Divergence D1: adk-python indexes `actual_invocations[0]` unguarded and
  // raises IndexError.
  it('returns an empty result for an empty conversation', async () => {
    const judgeModel = new FakeJudgeLlm([{critique: VALID_CRITIQUE}]);
    const evaluator = createEvaluator(judgeModel);

    const result = await evaluator.evaluateInvocations([], undefined, SCENARIO);

    expect(result).toEqual({
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
      perInvocationResults: [],
    });
    expect(judgeModel.requests).toHaveLength(0);
  });

  it('replaces the last turn when the stop-signal turn fails', async () => {
    // Turn 2 passes; the stop-signal turn that follows it fails.
    const judgeModel = new FakeJudgeLlm([
      {critique: VALID_CRITIQUE},
      {critique: INVALID_CRITIQUE},
    ]);
    const evaluator = createEvaluator(judgeModel, {
      threshold: 1.0,
      stopSignal: 'stop',
      judgeModelOptions: {numSamples: 1},
    });

    const result = await evaluator.evaluateInvocations(
      createConversation(),
      undefined,
      SCENARIO,
    );

    expect(result.perInvocationResults).toHaveLength(2);
    expect(result.perInvocationResults[1].evalStatus).toBe(EvalStatus.FAILED);
    expect(result.perInvocationResults[1].actualInvocation.invocationId).toBe(
      'stop_signal_proxy_invocation',
    );
    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('leaves the last turn alone when the stop-signal turn passes', async () => {
    const judgeModel = new FakeJudgeLlm([{critique: VALID_CRITIQUE}]);
    const evaluator = createEvaluator(judgeModel, {
      threshold: 1.0,
      stopSignal: 'stop',
      judgeModelOptions: {numSamples: 1},
    });

    const result = await evaluator.evaluateInvocations(
      createConversation(),
      undefined,
      SCENARIO,
    );

    expect(result.perInvocationResults).toHaveLength(2);
    expect(
      result.perInvocationResults[1].actualInvocation.invocationId,
    ).toBeUndefined();
    expect(result.overallScore).toBe(1.0);
  });

  it('stamps the default retry policy on every judge request', async () => {
    const judgeModel = new FakeJudgeLlm([{critique: VALID_CRITIQUE}]);
    const evaluator = createEvaluator(judgeModel, {
      threshold: 1.0,
      stopSignal: 'stop',
      judgeModelOptions: {numSamples: 1},
    });

    await evaluator.evaluateInvocations(
      createConversation(),
      undefined,
      SCENARIO,
    );

    expect(judgeModel.requests).not.toHaveLength(0);
    for (const request of judgeModel.requests) {
      expect(request.config?.httpOptions?.retryOptions?.attempts).toBe(
        DEFAULT_RETRY_ATTEMPTS,
      );
    }
  });

  it('sends the judge model its own name, not the configured one', async () => {
    const judgeModel = new FakeJudgeLlm([{critique: VALID_CRITIQUE}]);
    const evaluator = createEvaluator(judgeModel, {
      threshold: 1.0,
      stopSignal: 'stop',
      judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 1},
    });

    await evaluator.evaluateInvocations(
      createConversation(),
      undefined,
      SCENARIO,
    );

    expect(judgeModel.requests[0].model).toBe(FAKE_JUDGE_MODEL);
  });

  it('builds one prompt per turn and reuses it across that turn samples', async () => {
    const judgeModel = new FakeJudgeLlm([{critique: VALID_CRITIQUE}]);
    const numSamples = 3;
    const evaluator = createEvaluator(judgeModel, {
      threshold: 1.0,
      stopSignal: 'stop',
      judgeModelOptions: {numSamples},
    });

    await evaluator.evaluateInvocations(
      createConversation(),
      undefined,
      SCENARIO,
    );

    // One judged turn plus the stop-signal turn, sampled `numSamples` times.
    expect(judgeModel.requests).toHaveLength(2 * numSamples);
    const [first, ...rest] = judgeModel.requests.slice(0, numSamples);
    for (const request of rest) {
      expect(request).toBe(first);
    }
  });

  it('does not evaluate a turn when the criterion asks for no samples', async () => {
    const judgeModel = new FakeJudgeLlm([{critique: VALID_CRITIQUE}]);
    const evaluator = createEvaluator(judgeModel, {
      threshold: 1.0,
      stopSignal: 'stop',
      judgeModelOptions: {numSamples: 0},
    });

    const result = await evaluator.evaluateInvocations(
      createConversation(),
      undefined,
      SCENARIO,
    );

    expect(judgeModel.requests).toHaveLength(0);
    expect(result.perInvocationResults[1].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.overallScore).toBe(0.5);
  });

  // Divergence D4: `LlmAsJudge` throws when the judge answers nothing; this
  // metric follows adk-python and scores the turn as not evaluated.
  it('does not evaluate a turn when the judge answers nothing', async () => {
    const judgeModel = new FakeJudgeLlm([{silent: true}]);
    const evaluator = createEvaluator(judgeModel, {
      threshold: 1.0,
      stopSignal: 'stop',
      judgeModelOptions: {numSamples: 1},
    });

    const result = await evaluator.evaluateInvocations(
      createConversation(),
      undefined,
      SCENARIO,
    );

    expect(result.perInvocationResults[1].score).toBeUndefined();
    expect(result.perInvocationResults[1].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
  });

  it('ignores the expected invocations it is given', async () => {
    const judgeModel = new FakeJudgeLlm([{critique: VALID_CRITIQUE}]);
    const evaluator = createEvaluator(judgeModel, {
      threshold: 1.0,
      stopSignal: 'stop',
      judgeModelOptions: {numSamples: 1},
    });

    const result = await evaluator.evaluateInvocations(
      createConversation(),
      [createInvocation('unrelated', 'unrelated')],
      SCENARIO,
    );

    expect(result.overallScore).toBe(1.0);
  });

  it('judges each turn against the turns before it', async () => {
    const judgeModel = new FakeJudgeLlm([{critique: VALID_CRITIQUE}]);
    const evaluator = createEvaluator(judgeModel, {
      threshold: 1.0,
      stopSignal: 'stop',
      judgeModelOptions: {numSamples: 1},
    });

    await evaluator.evaluateInvocations(
      createConversation(),
      undefined,
      SCENARIO,
    );

    const secondTurnPrompt = judgeModel.requests[0].contents[0].parts?.[0].text;
    expect(secondTurnPrompt).toContain(
      `# Conversation History\nuser: ${SCENARIO.startingPrompt}\n\nmodel: model 1.`,
    );
    expect(secondTurnPrompt).toContain('# Generated User Response\nuser 2.');
  });
});

describe('parseIsValidLabel', () => {
  it('gives the same answer when called twice on one critique', () => {
    const response = '{"is_valid": "valid"}';

    expect(parseIsValidLabel(response)).toBe(Label.VALID);
    expect(parseIsValidLabel(response)).toBe(Label.VALID);
  });

  it('strips the braces and case a judge writes around the verdict', () => {
    expect(parseIsValidLabel('{"is_valid": TRUE}}')).toBe(Label.VALID);
    expect(parseIsValidLabel('{"is_valid": }true}')).toBe(Label.VALID);
  });

  it('reports a verdict it does not recognise as not found', () => {
    expect(parseIsValidLabel('{"is_valid": maybe}')).toBe(Label.NOT_FOUND);
  });
});

describe('formatConversationHistory', () => {
  // Divergence D2: adk-python writes the literal `None:` for a response whose
  // content names no role.
  it('names a response with no role after the model', () => {
    const history = formatConversationHistory([
      {
        userContent: {parts: [{text: 'hello'}]},
        finalResponse: {parts: [{text: 'hi'}]},
      },
    ]);

    expect(history).toBe('user: hello\n\nmodel: hi');
  });

  it('skips a turn whose user content carries no parts', () => {
    const history = formatConversationHistory([
      {userContent: {}, finalResponse: {parts: [{text: 'hi'}], role: 'model'}},
    ]);

    expect(history).toBe('model: hi');
  });
});

describe('aggregateSamples', () => {
  it('rejects an empty sample list', () => {
    expect(() => aggregateSamples([])).toThrow(
      'No samples to aggregate into a result.',
    );
  });

  it('counts a tie as invalid', () => {
    const invocation = createInvocation('user', 'model');
    const samples = [
      {actualInvocation: invocation, score: 1.0, evalStatus: EvalStatus.PASSED},
      {actualInvocation: invocation, score: 0.0, evalStatus: EvalStatus.FAILED},
    ];

    expect(aggregateSamples(samples)).toBe(samples[1]);
  });
});

describe('aggregateConversationResults', () => {
  it('scores nothing when there are no results', () => {
    expect(aggregateConversationResults([], 1.0)).toEqual({
      perInvocationResults: [],
      overallEvalStatus: EvalStatus.NOT_EVALUATED,
    });
  });

  it('ignores a result that passed without a score', () => {
    const results = [
      {
        actualInvocation: createInvocation('user', 'model'),
        evalStatus: EvalStatus.PASSED,
      },
      {
        actualInvocation: createInvocation('user', 'model'),
        score: 1.0,
        evalStatus: EvalStatus.PASSED,
      },
    ];

    expect(aggregateConversationResults(results, 0.5).overallScore).toBe(0.5);
  });
});

describe('formatJudgePrompt', () => {
  it('renders the persona criteria of a scenario that names a persona', () => {
    const userPersona: UserPersona = {
      id: 'impatient',
      description: 'An impatient traveller.',
      behaviors: [
        {
          name: 'terse',
          description: 'Answers in as few words as possible.',
          behaviorInstructions: ['Keep it short.'],
          violationRubrics: ['Writes a paragraph.'],
        },
      ],
    };

    const prompt = formatJudgePrompt({
      invocation: createInvocation('user 2.', 'model 2.'),
      conversationScenario: {...SCENARIO, userPersona},
      previousInvocations: [],
      stopSignal: 'stop',
    });

    expect(prompt).toContain('## Criteria: terse');
    expect(prompt).toContain('  * Writes a paragraph.');
    expect(prompt).toContain('# Persona Description\nAn impatient traveller.');
  });
});

describe('convertLlmResponseToScore', () => {
  it('scores nothing when the judge response carries no content', () => {
    expect(convertLlmResponseToScore({})).toEqual({});
  });
});

describe('evaluateFirstTurn', () => {
  it('does not evaluate a first turn whose only part carries no text', () => {
    const result = evaluateFirstTurn(
      {userContent: {parts: [{inlineData: {mimeType: 'audio/wav'}}]}},
      SCENARIO,
      1.0,
    );

    expect(result.score).toBeUndefined();
    expect(result.evalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });
});

describe('persona template rendering', () => {
  function renderBehaviorName(name: string): string {
    return formatJudgePrompt({
      invocation: createInvocation('user 2.', 'model 2.'),
      conversationScenario: {
        ...SCENARIO,
        userPersona: {
          id: 'p',
          description: 'A persona.',
          behaviors: [
            {
              name,
              description: 'A behavior.',
              behaviorInstructions: [],
              violationRubrics: [],
            },
          ],
        },
      },
      previousInvocations: [],
      stopSignal: 'stop',
    });
  }

  it('renders a variable the scope does not name as nothing', () => {
    expect(renderBehaviorName('criteria {{ missing }}')).toContain(
      '## Criteria: criteria \n',
    );
  });

  it('renders a path that walks into a string as nothing', () => {
    expect(renderBehaviorName('criteria {{ stop_signal.length }}')).toContain(
      '## Criteria: criteria \n',
    );
  });

  it('does not rescan a value it substituted', () => {
    // `conversation_plan` is substituted last, so a plan naming another
    // variable stays literal instead of resolving it.
    const prompt = formatJudgePrompt({
      invocation: createInvocation('user 2.', 'model 2.'),
      conversationScenario: {
        ...SCENARIO,
        conversationPlan: 'plan {{ stop_signal }}',
      },
      previousInvocations: [],
      stopSignal: 'stop',
    });

    expect(prompt).toContain('# Conversation Plan\nplan {{ stop_signal }}');
  });
});
