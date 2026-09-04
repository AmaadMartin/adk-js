/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the paths of `PerTurnUserSimulatorQualityV1` that
 * `per_turn_user_simulator_quality_v1_test.ts` does not: the guards, the
 * stop-signal turn, a silent judge, and a conversation driven with a persona.
 * The ported tests stay in that file so a reviewer can match them against
 * adk-python one by one.
 */

import {
  BaseLlm,
  DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
  EvalStatus,
  InputValidationError,
  LLMRegistry,
  Label,
  PerTurnUserSimulatorQualityV1,
  aggregateConversationResults,
  aggregateSamples,
  convertLlmResponseToScore,
  evaluateFirstTurn,
  formatConversationHistory,
  parseIsValidLabel,
  type BaseLlmConnection,
  type ConversationScenario,
  type EvalMetric,
  type Invocation,
  type LlmResponse,
  type UserPersona,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  FAKE_JUDGE_MODEL,
  FakeJudgeLlm,
  type JudgeReply,
} from '../fake_judge_llm.js';

const STOP_SIGNAL = 'test stop signal';
const STARTING_PROMPT = 'first user prompt.';

const VALID_REPLY: JudgeReply = {critique: '{"is_valid": true}'};
const INVALID_REPLY: JudgeReply = {critique: '{"is_valid": false}'};

const PERSONA: UserPersona = {
  id: 'impatient',
  description: 'An impatient user.',
  behaviors: [
    {
      name: 'terse',
      description: 'Writes as few words as possible.',
      behaviorInstructions: ['Answer in one sentence.'],
      violationRubrics: ['The response runs to several paragraphs.'],
    },
  ],
};

function evalMetric(options: {
  threshold?: number;
  stopSignal?: string;
  numSamples?: number;
}): EvalMetric {
  const threshold = options.threshold ?? 1.0;
  return {
    metricName: 'per_turn_user_simulator_quality_v1',
    criterion: {
      threshold,
      stopSignal: options.stopSignal ?? STOP_SIGNAL,
      judgeModelOptions: {
        judgeModel: 'gemini-2.5-flash',
        numSamples: options.numSamples ?? 1,
      },
    },
  };
}

function createEvaluator(
  replies: JudgeReply[],
  options: {threshold?: number; numSamples?: number} = {},
): {evaluator: PerTurnUserSimulatorQualityV1; judge: FakeJudgeLlm} {
  const judge = new FakeJudgeLlm(replies);
  return {
    evaluator: new PerTurnUserSimulatorQualityV1({
      evalMetric: evalMetric(options),
      judgeModel: judge,
    }),
    judge,
  };
}

function scenario(userPersona?: UserPersona): ConversationScenario {
  return {
    startingPrompt: STARTING_PROMPT,
    conversationPlan: 'Book a flight, then rent a car.',
    userPersona,
  };
}

function turn(userText: string, modelText: string): Invocation {
  return {
    userContent: {parts: [{text: userText}], role: 'user'},
    finalResponse: {parts: [{text: modelText}], role: 'model'},
  };
}

const TWO_TURNS: Invocation[] = [
  turn(STARTING_PROMPT, 'Sure, where to?'),
  turn('To Lisbon.', 'Booked.'),
];

/** The model name the registry resolves to {@link RegisteredJudgeLlm}. */
const REGISTERED_JUDGE_MODEL = 'per-turn-quality-registry-judge';

/** A judge the registry owns, so the metric can resolve one for itself. */
class RegisteredJudgeLlm extends BaseLlm {
  static readonly supportedModels = [REGISTERED_JUDGE_MODEL];

  /** How many times the registry's judge answered. */
  static calls = 0;

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    RegisteredJudgeLlm.calls++;
    yield {content: {role: 'model', parts: [{text: '{"is_valid": true}'}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('RegisteredJudgeLlm does not support live connections.');
  }
}

describe('parseIsValidLabel', () => {
  it('strips every comma, not only the first', () => {
    expect(parseIsValidLabel('{"is_valid": "partially, valid,",}')).toBe(
      Label.INVALID,
    );
  });

  it('strips braces from both ends of the captured label', () => {
    expect(parseIsValidLabel('{"is_valid": }true},')).toBe(Label.VALID);
  });

  it('reports NOT_FOUND when the critique names no verdict', () => {
    expect(parseIsValidLabel('the judge said nothing useful')).toBe(
      Label.NOT_FOUND,
    );
  });
});

describe('evaluateFirstTurn', () => {
  it('ignores whitespace around the starting prompt', () => {
    const result = evaluateFirstTurn(
      turn(`  ${STARTING_PROMPT}\n`, 'Sure, where to?'),
      scenario(),
      1.0,
    );

    expect(result.score).toBe(1);
    expect(result.evalStatus).toBe(EvalStatus.PASSED);
  });
});

describe('convertLlmResponseToScore', () => {
  it('scores nothing when the judge response holds no text', () => {
    expect(convertLlmResponseToScore({})).toEqual({});
  });
});

describe('formatConversationHistory', () => {
  it('names an agent reply that carries no role `model`', () => {
    const history = formatConversationHistory([
      {
        userContent: {parts: [{text: 'hi'}]},
        finalResponse: {parts: [{text: 'hello'}]},
      },
    ]);

    expect(history).toBe('user: hi\n\nmodel: hello');
  });
});

describe('aggregateSamples', () => {
  it('rejects an empty sample list', () => {
    expect(() => aggregateSamples([])).toThrow(InputValidationError);
    expect(() => aggregateSamples([])).toThrow(
      'No samples to aggregate into a result.',
    );
  });

  it('counts a tie as invalid', () => {
    const samples = [
      {
        actualInvocation: TWO_TURNS[0],
        score: 1.0,
        evalStatus: EvalStatus.PASSED,
      },
      {
        actualInvocation: TWO_TURNS[1],
        score: 0.0,
        evalStatus: EvalStatus.FAILED,
      },
    ];

    expect(aggregateSamples(samples)).toBe(samples[1]);
  });
});

describe('aggregateConversationResults', () => {
  it('reports no score for a conversation with no turns', () => {
    const result = aggregateConversationResults([], 1.0);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
  });

  it('ignores the score of a turn that did not pass', () => {
    const result = aggregateConversationResults(
      [
        {
          actualInvocation: TWO_TURNS[0],
          score: 1.0,
          evalStatus: EvalStatus.FAILED,
        },
        {
          actualInvocation: TWO_TURNS[1],
          score: 1.0,
          evalStatus: EvalStatus.PASSED,
        },
      ],
      0.5,
    );

    expect(result.overallScore).toBe(0.5);
  });
});

describe('PerTurnUserSimulatorQualityV1', () => {
  it('rejects a metric that carries no criterion', () => {
    expect(
      () =>
        new PerTurnUserSimulatorQualityV1({
          evalMetric: {metricName: 'per_turn_user_simulator_quality_v1'},
        }),
    ).toThrow(
      '`per_turn_user_simulator_quality_v1` metric expects a criterion of' +
        ' type `LlmBackedUserSimulatorCriterion`.',
    );
  });

  it('rejects a criterion that names no threshold', () => {
    expect(
      () =>
        new PerTurnUserSimulatorQualityV1({
          evalMetric: {
            metricName: 'per_turn_user_simulator_quality_v1',
            criterion: {stopSignal: STOP_SIGNAL} as unknown as {
              threshold: number;
            },
          },
        }),
    ).toThrow(InputValidationError);
  });

  it('resolves the judge model through the registry when none is supplied', async () => {
    LLMRegistry.register(RegisteredJudgeLlm);
    const evaluator = new PerTurnUserSimulatorQualityV1({
      evalMetric: {
        metricName: 'per_turn_user_simulator_quality_v1',
        criterion: {
          threshold: 1.0,
          stopSignal: STOP_SIGNAL,
          judgeModelOptions: {
            judgeModel: REGISTERED_JUDGE_MODEL,
            numSamples: 1,
          },
        },
      },
    });

    const result = await evaluator.evaluateInvocations(
      [TWO_TURNS[0]],
      undefined,
      scenario(),
    );

    expect(RegisteredJudgeLlm.calls).toBe(1);
    expect(result.overallScore).toBe(1.0);
  });

  it('rejects a call that supplies no conversation scenario', async () => {
    const {evaluator} = createEvaluator([VALID_REPLY]);

    await expect(evaluator.evaluateInvocations(TWO_TURNS)).rejects.toThrow(
      'conversationScenario is needed by this metric.',
    );
  });

  it('evaluates nothing for an empty conversation', async () => {
    const {evaluator, judge} = createEvaluator([VALID_REPLY]);

    const result = await evaluator.evaluateInvocations(
      [],
      undefined,
      scenario(),
    );

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
    expect(judge.requests).toHaveLength(0);
  });

  it('never reads the golden invocations it is given', async () => {
    const {evaluator} = createEvaluator([VALID_REPLY]);

    const withGolden = await evaluator.evaluateInvocations(
      TWO_TURNS,
      [turn('golden', 'golden')],
      scenario(),
    );
    const withoutGolden = await evaluator.evaluateInvocations(
      TWO_TURNS,
      undefined,
      scenario(),
    );

    expect(withGolden).toEqual(withoutGolden);
  });

  it('asks the judge once per later turn, and once about the ending', async () => {
    const {evaluator, judge} = createEvaluator([VALID_REPLY]);

    await evaluator.evaluateInvocations(TWO_TURNS, undefined, scenario());

    // One call for the second turn, one for the stop-signal turn. The first
    // turn is compared against the starting prompt instead.
    expect(judge.requests).toHaveLength(2);
    expect(judge.requests[0].model).toBe(FAKE_JUDGE_MODEL);
    expect(judge.requests[0].config?.httpOptions?.retryOptions).toBeDefined();
    const stopSignalPrompt = judge.requests[1].contents[0].parts?.[0].text;
    expect(stopSignalPrompt).toContain(
      `# Generated User Response\n${STOP_SIGNAL}`,
    );
  });

  it('marks the last turn as the failure site when the conversation should have ended', async () => {
    // The second turn passes; the stop-signal turn fails, so it replaces the
    // second turn's result rather than adding a third.
    const {evaluator} = createEvaluator([VALID_REPLY, INVALID_REPLY]);

    const result = await evaluator.evaluateInvocations(
      TWO_TURNS,
      undefined,
      scenario(),
    );

    expect(result.perInvocationResults).toHaveLength(2);
    expect(result.perInvocationResults[1].score).toBe(0.0);
    expect(result.perInvocationResults[1].actualInvocation.invocationId).toBe(
      'stop_signal_proxy_invocation',
    );
    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });

  it('keeps the last turn when the conversation ended correctly', async () => {
    const {evaluator} = createEvaluator([VALID_REPLY]);

    const result = await evaluator.evaluateInvocations(
      TWO_TURNS,
      undefined,
      scenario(),
    );

    expect(result.perInvocationResults).toHaveLength(2);
    expect(result.perInvocationResults[1].actualInvocation).toBe(TWO_TURNS[1]);
    expect(result.overallScore).toBe(1.0);
  });

  it('puts the persona in front of the judge', async () => {
    const {evaluator, judge} = createEvaluator([VALID_REPLY]);

    const result = await evaluator.evaluateInvocations(
      TWO_TURNS,
      undefined,
      scenario(PERSONA),
    );

    const prompt = judge.requests[0].contents[0].parts?.[0].text ?? '';
    expect(prompt).toContain('## Criteria: terse');
    expect(prompt).toContain('  * The response runs to several paragraphs.');
    expect(prompt).toContain('# Persona Description\nAn impatient user.');
    expect(result.overallScore).toBe(1.0);
  });

  it('evaluates nothing when the criterion asks for no samples', async () => {
    const {evaluator, judge} = createEvaluator([VALID_REPLY], {numSamples: 0});

    const result = await evaluator.evaluateInvocations(
      TWO_TURNS,
      undefined,
      scenario(),
    );

    expect(judge.requests).toHaveLength(0);
    expect(result.perInvocationResults[1].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    // Only the first turn passed, out of two turns.
    expect(result.overallScore).toBe(0.5);
  });

  it('scores nothing for a turn the judge does not answer', async () => {
    const {evaluator} = createEvaluator([{silent: true}]);

    const result = await evaluator.evaluateInvocations(
      TWO_TURNS,
      undefined,
      scenario(),
    );

    expect(result.perInvocationResults[1].score).toBeUndefined();
    expect(result.perInvocationResults[1].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
  });

  it('propagates a judge call that fails', async () => {
    const {evaluator} = createEvaluator([{failure: 'judge is down'}]);

    await expect(
      evaluator.evaluateInvocations(TWO_TURNS, undefined, scenario()),
    ).rejects.toThrow('judge is down');
  });

  it('takes the majority verdict over repeated samples of one turn', async () => {
    const {evaluator} = createEvaluator(
      [VALID_REPLY, INVALID_REPLY, VALID_REPLY],
      {numSamples: 3},
    );

    const result = await evaluator.evaluateInvocations(
      [TWO_TURNS[0]],
      undefined,
      scenario(),
    );

    expect(result.perInvocationResults).toHaveLength(1);
    expect(result.overallScore).toBe(1.0);
  });

  it('defaults the stop signal when the criterion names none', async () => {
    const judge = new FakeJudgeLlm([VALID_REPLY]);
    const evaluator = new PerTurnUserSimulatorQualityV1({
      evalMetric: {
        metricName: 'per_turn_user_simulator_quality_v1',
        criterion: {threshold: 1.0, judgeModelOptions: {numSamples: 1}},
      },
      judgeModel: judge,
    });

    await evaluator.evaluateInvocations([TWO_TURNS[0]], undefined, scenario());

    const prompt = judge.requests[0].contents[0].parts?.[0].text ?? '';
    expect(prompt).toContain(
      `# Generated User Response\n${DEFAULT_USER_SIMULATOR_STOP_SIGNAL}`,
    );
  });
});
