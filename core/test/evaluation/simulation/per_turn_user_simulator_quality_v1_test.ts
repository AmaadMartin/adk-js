/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {InputValidationError} from '../../../src/errors/input_validation_error.js';
import type {ConversationScenario} from '../../../src/evaluation/conversation_scenarios.js';
import type {Invocation} from '../../../src/evaluation/eval_case.js';
import {
  DEFAULT_USER_SIMULATOR_STOP_SIGNAL,
  type EvalMetric,
} from '../../../src/evaluation/eval_metrics.js';
import {
  EvalStatus,
  type PerInvocationResult,
} from '../../../src/evaluation/evaluator.js';
import {Label} from '../../../src/evaluation/llm_as_judge_utils.js';
import {
  aggregateConversationResults,
  aggregateSamples,
  convertLlmResponseToScore,
  evaluateFirstTurn,
  formatConversationHistory,
  formatPerTurnUserSimulatorPrompt,
  parseIsValidLabel,
  PerTurnUserSimulatorQualityV1,
} from '../../../src/evaluation/simulation/per_turn_user_simulator_quality_v1.js';
import {BaseLlm} from '../../../src/models/base_llm.js';
import type {BaseLlmConnection} from '../../../src/models/base_llm_connection.js';
import type {LlmResponse} from '../../../src/models/llm_response.js';
import {LLMRegistry} from '../../../src/models/registry.js';
import {
  FAKE_JUDGE_MODEL,
  FakeJudgeLlm,
  type JudgeReply,
} from '../fake_judge_llm.js';

const STOP_SIGNAL = 'test stop signal';

/**
 * A judge critique in the shape the reference uses. Only the `is_valid` line
 * varies between the reference cases; `passes` is not read by the parser.
 */
function critique(isValidLine: string): string {
  return [
    '```json',
    '  {',
    '    "criteria": [',
    '      {',
    '        "name": "TEST_NAME",',
    '        "reasoning": "test_resonining",',
    '        "passes": True',
    '      }',
    '    ],',
    `    ${isValidLine}`,
    '  }',
    '  ```',
  ].join('\n');
}

function llmResponse(text: string): LlmResponse {
  return {content: {role: 'model', parts: [{text}]}};
}

function createTestEvaluator(options: {
  threshold?: number;
  numSamples?: number;
  judgeModelConfig?: Record<string, never>;
  judgeModel: FakeJudgeLlm;
}): PerTurnUserSimulatorQualityV1 {
  const threshold = options.threshold ?? 1.0;
  return new PerTurnUserSimulatorQualityV1({
    evalMetric: {
      metricName: 'test_per_turn_user_simulator_quality_v1',
      threshold,
      criterion: {
        threshold,
        stopSignal: STOP_SIGNAL,
        judgeModelOptions: {
          judgeModel: 'gemini-2.5-flash',
          judgeModelConfig: options.judgeModelConfig,
          numSamples: options.numSamples ?? 3,
        },
      },
    },
    judgeModel: options.judgeModel,
  });
}

function createTestConversationScenario(
  startingPrompt = 'test starting prompt',
  conversationPlan = 'test conversation plan',
): ConversationScenario {
  return {startingPrompt, conversationPlan};
}

function createTestInvocation(
  invocationId: string,
  userContent = 'user content',
  modelContent = 'model content',
): Invocation {
  return {
    invocationId,
    userContent: {role: 'user', parts: [{text: userContent}]},
    finalResponse: {role: 'model', parts: [{text: modelContent}]},
  };
}

/** Builds one invocation per user/agent pair, in order. */
function createTestInvocations(conversationHistory: string[]): Invocation[] {
  expect(conversationHistory.length % 2).toBe(0);

  const invocations: Invocation[] = [];
  for (let turn = 0; turn < conversationHistory.length / 2; turn++) {
    invocations.push(
      createTestInvocation(
        `turn ${turn}`,
        conversationHistory[2 * turn],
        conversationHistory[2 * turn + 1],
      ),
    );
  }
  return invocations;
}

function sample(
  invocationId: string,
  score: number | undefined,
  evalStatus: EvalStatus,
): PerInvocationResult {
  return {
    actualInvocation: createTestInvocation(invocationId),
    score,
    evalStatus,
  };
}

const STARTING_PROMPT = 'first user prompt.';
const VALID_CRITIQUE = '{"is_valid": true}';
const INVALID_CRITIQUE = '{"is_valid": false}';

const SCENARIO: ConversationScenario = {
  startingPrompt: STARTING_PROMPT,
  conversationPlan: 'book a flight',
};

function turn(userText: string, modelText: string): Invocation {
  return {
    invocationId: userText,
    userContent: {role: 'user', parts: [{text: userText}]},
    finalResponse: {role: 'model', parts: [{text: modelText}]},
  };
}

const CONVERSATION = [
  turn(STARTING_PROMPT, 'model 1.'),
  turn('user 2.', 'model 2.'),
];

function metricWith(criterion: EvalMetric['criterion']): EvalMetric {
  return {metricName: 'per_turn_user_simulator_quality_v1', criterion};
}

const REGISTERED_JUDGE_MODEL = 'registry-resolved-test-judge';

/** A judge the metric can only reach by resolving it through `LLMRegistry`. */
class RegisteredJudgeLlm extends BaseLlm {
  static override readonly supportedModels = [REGISTERED_JUDGE_MODEL];

  /** How many times the metric asked this judge, across all instances. */
  static calls = 0;

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    RegisteredJudgeLlm.calls++;
    yield {content: {role: 'model', parts: [{text: VALID_CRITIQUE}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('RegisteredJudgeLlm does not support live connections.');
  }
}

function evaluatorWith(
  replies: JudgeReply[],
  criterion: EvalMetric['criterion'],
): {evaluator: PerTurnUserSimulatorQualityV1; judge: FakeJudgeLlm} {
  const judge = new FakeJudgeLlm(replies);
  return {
    evaluator: new PerTurnUserSimulatorQualityV1({
      evalMetric: metricWith(criterion),
      judgeModel: judge,
    }),
    judge,
  };
}

function promptOf(judge: FakeJudgeLlm, requestIndex: number): string {
  const text = judge.requests[requestIndex].contents[0].parts?.[0].text;
  if (text === undefined) {
    return expect.fail('The judge was sent a request with no prompt text.');
  }
  return text;
}

/**
 * Ported from
 * `tests/unittests/evaluation/simulation/test_per_turn_user_simulation_quality_v1.py`
 * of `google/adk-python`, at commit 852b575e9d12. Each `it` keeps the name of
 * the reference test it came from.
 *
 * Where the reference calls a private method, this calls the module-level
 * function the port extracted. Where the reference replaces `_sample_llm` with
 * a stub, this injects a `FakeJudgeLlm`.
 */
describe('ported from adk-python', () => {
  describe('parseIsValidLabel', () => {
    it.each([
      ['"is_valid_undefined_key": True'],
      ['"is_valid": "undefined label",'],
    ])('test_parse_llm_response_label_not_found (%s)', (isValidLine) => {
      expect(parseIsValidLabel(critique(isValidLine))).toBe(Label.NOT_FOUND);
    });

    it.each([
      ['"is_valid": True'],
      ['"is_valid": "true"'],
      ['"is_valid": "valid"'],
    ])('test_parse_llm_response_label_valid (%s)', (isValidLine) => {
      expect(parseIsValidLabel(critique(isValidLine))).toBe(Label.VALID);
    });

    it.each([
      ['"is_valid": False'],
      ['"is_valid": "false",'],
      ['"is_valid": "invalid",'],
      ['"is_valid": "almost",'],
      ['"is_valid": "partially_valid",'],
      ['"is_valid": "partially valid",'],
      ['"is_valid": "partially",'],
    ])('test_parse_llm_response_label_invalid (%s)', (isValidLine) => {
      expect(parseIsValidLabel(critique(isValidLine))).toBe(Label.INVALID);
    });
  });

  describe('formatPerTurnUserSimulatorPrompt', () => {
    it('test_format_llm_prompt_raises_error_if_previous_invocations_is_none', () => {
      expect(() =>
        formatPerTurnUserSimulatorPrompt({
          invocation: createTestInvocation('1'),
          conversationScenario: createTestConversationScenario(),
          previousInvocations: undefined,
          stopSignal: STOP_SIGNAL,
        }),
      ).toThrow(/Previous invocations should have a set value/);
    });

    it('test_format_llm_prompt_raises_error_if_conversation_scenario_is_none', () => {
      expect(() =>
        formatPerTurnUserSimulatorPrompt({
          invocation: createTestInvocation('1'),
          conversationScenario: undefined,
          previousInvocations: [],
          stopSignal: STOP_SIGNAL,
        }),
      ).toThrow(/Conversation scenario should have a set value/);
    });
  });

  describe('convertLlmResponseToScore', () => {
    it('test_convert_llm_response_to_score_pass', () => {
      const response = ['```json', '{', '  "is_valid": True,', '}', '```'].join(
        '\n',
      );

      expect(convertLlmResponseToScore(llmResponse(response))).toEqual({
        score: 1.0,
      });
    });

    it('test_convert_llm_response_to_score_failure', () => {
      const response = [
        '```json',
        '{',
        '  "is_valid": False,',
        '}',
        '```',
      ].join('\n');

      expect(convertLlmResponseToScore(llmResponse(response))).toEqual({
        score: 0.0,
      });
    });

    it('test_convert_llm_response_to_score_invalid_json', () => {
      expect(convertLlmResponseToScore(llmResponse('invalid json'))).toEqual(
        {},
      );
    });

    it('test_convert_llm_response_to_score_missing_key', () => {
      expect(convertLlmResponseToScore(llmResponse('{}'))).toEqual({});
    });
  });

  describe('aggregateSamples', () => {
    it('test_aggregate_samples_not_evaluated', () => {
      const samples = [
        sample('1', undefined, EvalStatus.NOT_EVALUATED),
        sample('2', undefined, EvalStatus.NOT_EVALUATED),
      ];

      expect(aggregateSamples(samples)).toBe(samples[0]);
    });

    it('test_aggregate_samples_pass', () => {
      const aggregated = aggregateSamples([
        sample('1', 1.0, EvalStatus.PASSED),
        sample('2', 1.0, EvalStatus.PASSED),
        sample('3', 0.0, EvalStatus.FAILED),
      ]);

      expect(aggregated.score).toBe(1.0);
      expect(aggregated.evalStatus).toBe(EvalStatus.PASSED);
    });

    it('test_aggregate_samples_failure', () => {
      const aggregated = aggregateSamples([
        sample('1', 1.0, EvalStatus.PASSED),
        sample('2', 0.0, EvalStatus.FAILED),
        sample('3', 0.0, EvalStatus.FAILED),
      ]);

      expect(aggregated.score).toBe(0.0);
      expect(aggregated.evalStatus).toBe(EvalStatus.FAILED);
    });
  });

  describe('formatConversationHistory', () => {
    it('test_format_conversation_history_with_none_values', () => {
      const invocations: Invocation[] = [{invocationId: '1', userContent: {}}];

      expect(formatConversationHistory(invocations)).toBe('');
    });

    it('test_format_conversation_history', () => {
      const invocations = createTestInvocations([
        'first user prompt.',
        'first agent response.',
        'second user prompt.',
        'second agent response.',
      ]);

      expect(formatConversationHistory(invocations)).toBe(
        [
          'user: first user prompt.',
          '',
          'model: first agent response.',
          '',
          'user: second user prompt.',
          '',
          'model: second agent response.',
        ].join('\n'),
      );
    });
  });

  describe('evaluateFirstTurn', () => {
    it('test_evaluate_first_turn_pass', () => {
      const result = evaluateFirstTurn(
        createTestInvocation('1', 'test starting prompt'),
        createTestConversationScenario('test starting prompt', 'plan'),
        0.8,
      );

      expect(result.score).toBe(1.0);
      expect(result.evalStatus).toBe(EvalStatus.PASSED);
    });

    it('test_evaluate_first_turn_failure', () => {
      const result = evaluateFirstTurn(
        createTestInvocation('1', 'wrong starting prompt'),
        createTestConversationScenario('test starting prompt', 'plan'),
        1.0,
      );

      expect(result.score).toBe(0.0);
      expect(result.evalStatus).toBe(EvalStatus.FAILED);
    });

    // adk-python's `Invocation.user_content` is optional and the reference
    // guards on it being absent. adk-js requires it, so the two reference cases
    // both land on the no-text guard.
    it.each([{role: 'user', parts: []}, {}])(
      'test_evaluate_first_turn_not_evaluated_when_user_content_has_no_text (%o)',
      (userContent) => {
        const result = evaluateFirstTurn(
          {invocationId: '1', userContent},
          createTestConversationScenario('test starting prompt', 'plan'),
          1.0,
        );

        expect(result.score).toBeUndefined();
        expect(result.evalStatus).toBe(EvalStatus.NOT_EVALUATED);
      },
    );
  });

  describe('aggregateConversationResults', () => {
    it('test_aggregate_conversation_results_all_pass_produces_pass', () => {
      const aggregated = aggregateConversationResults(
        [
          sample('1', 1.0, EvalStatus.PASSED),
          sample('2', 1.0, EvalStatus.PASSED),
          sample('3', 1.0, EvalStatus.PASSED),
          sample('4', 1.0, EvalStatus.PASSED),
        ],
        1.0,
      );

      expect(aggregated.overallScore).toBe(1.0);
      expect(aggregated.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('test_aggregate_conversation_results_percentage_above_threshold_produces_pass', () => {
      const aggregated = aggregateConversationResults(
        [
          sample('1', 1.0, EvalStatus.PASSED),
          sample('2', 1.0, EvalStatus.PASSED),
          sample('3', 0.0, EvalStatus.PASSED),
          sample('4', 1.0, EvalStatus.PASSED),
        ],
        0.7,
      );

      expect(aggregated.overallScore).toBe(0.75);
      expect(aggregated.overallEvalStatus).toBe(EvalStatus.PASSED);
    });

    it('test_aggregate_conversation_results_all_failures_produces_failure', () => {
      const aggregated = aggregateConversationResults(
        [
          sample('1', 0.0, EvalStatus.FAILED),
          sample('2', 0.0, EvalStatus.FAILED),
          sample('3', 0.0, EvalStatus.FAILED),
          sample('4', 0.0, EvalStatus.FAILED),
        ],
        1.0,
      );

      expect(aggregated.overallScore).toBe(0.0);
      expect(aggregated.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('test_aggregate_conversation_percentage_below_threshold_produces_failure', () => {
      const aggregated = aggregateConversationResults(
        [
          sample('1', 0.0, EvalStatus.FAILED),
          sample('2', 1.0, EvalStatus.PASSED),
          sample('3', 1.0, EvalStatus.PASSED),
          sample('4', 1.0, EvalStatus.PASSED),
        ],
        1.0,
      );

      expect(aggregated.overallScore).toBe(0.75);
      expect(aggregated.overallEvalStatus).toBe(EvalStatus.FAILED);
    });
  });

  describe('PerTurnUserSimulatorQualityV1.evaluateInvocations', () => {
    it('test_evaluate_invocations_all_pass', async () => {
      const startingPrompt = 'first user prompt.';
      const evaluator = createTestEvaluator({
        judgeModel: new FakeJudgeLlm([
          {critique: critique('"is_valid": True')},
        ]),
      });

      const result = await evaluator.evaluateInvocations(
        createTestInvocations([
          startingPrompt,
          'model 1.',
          'user 2.',
          'model 2.',
        ]),
        undefined,
        createTestConversationScenario(startingPrompt),
      );

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
      expect(result.perInvocationResults).toHaveLength(2);
      expect(result.perInvocationResults[0].score).toBe(1.0);
      expect(result.perInvocationResults[1].score).toBe(1.0);
    });

    it('test_evaluate_invocations_none_judge_model_config', async () => {
      const startingPrompt = 'first user prompt.';
      const evaluator = createTestEvaluator({
        numSamples: 1,
        judgeModelConfig: undefined,
        judgeModel: new FakeJudgeLlm([
          {critique: critique('"is_valid": True')},
        ]),
      });

      const result = await evaluator.evaluateInvocations(
        createTestInvocations([
          startingPrompt,
          'model 1.',
          'user 2.',
          'model 2.',
        ]),
        undefined,
        createTestConversationScenario(startingPrompt),
      );

      expect(result.overallScore).toBe(1.0);
      expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    });
  });

  describe('InputValidationError from the ported error paths', () => {
    it('reports an absent previous invocation list as invalid input', () => {
      expect(() =>
        formatPerTurnUserSimulatorPrompt({
          invocation: createTestInvocation('1'),
          conversationScenario: createTestConversationScenario(),
          stopSignal: STOP_SIGNAL,
        }),
      ).toThrow(InputValidationError);
    });
  });
});

/**
 * Cases the adk-python reference tests do not cover: criterion validation, the
 * judge model the metric actually calls, the stop-signal turn, and the guards
 * around an empty conversation.
 */
describe('adk-js specific', () => {
  describe('PerTurnUserSimulatorQualityV1 construction', () => {
    it('rejects a metric that carries no criterion', () => {
      expect(
        () =>
          new PerTurnUserSimulatorQualityV1({
            evalMetric: metricWith(undefined),
          }),
      ).toThrow(
        '`per_turn_user_simulator_quality_v1` metric expects a criterion of ' +
          'type `LlmBackedUserSimulatorCriterion`.',
      );
    });

    it('reports the criterion the parser rejected as the cause', () => {
      // A judge cannot sample a model one and a half times.
      const construct = () =>
        new PerTurnUserSimulatorQualityV1({
          evalMetric: metricWith({
            threshold: 0.8,
            judgeModelOptions: {numSamples: 1.5},
          }),
        });

      expect(construct).toThrow(
        '`per_turn_user_simulator_quality_v1` metric expects a criterion of ' +
          'type `LlmBackedUserSimulatorCriterion`.',
      );

      let caught: Error | undefined;
      try {
        construct();
      } catch (error) {
        if (!(error instanceof Error)) {
          expect.fail(`The constructor threw a non-error: ${String(error)}`);
        }
        caught = error;
      }
      expect(caught?.cause).toBeInstanceOf(Error);
    });

    it('resolves the judge model from the registry when none is given', async () => {
      LLMRegistry.register(RegisteredJudgeLlm);
      RegisteredJudgeLlm.calls = 0;

      const evaluator = new PerTurnUserSimulatorQualityV1({
        evalMetric: metricWith({
          threshold: 0.8,
          judgeModelOptions: {
            judgeModel: REGISTERED_JUDGE_MODEL,
            numSamples: 1,
          },
        }),
      });
      await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

      expect(RegisteredJudgeLlm.calls).toBe(2);
    });
  });

  describe('PerTurnUserSimulatorQualityV1 judge calls', () => {
    it('sends the prompt to the injected judge, not to the criterion model', async () => {
      const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
        threshold: 0.8,
        judgeModelOptions: {judgeModel: 'gemini-2.5-flash', numSamples: 1},
      });

      await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

      expect(judge.requests.every((r) => r.model === FAKE_JUDGE_MODEL)).toBe(
        true,
      );
    });

    it('stamps the default retry policy onto every judge request', async () => {
      const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
        threshold: 0.8,
        judgeModelOptions: {numSamples: 1},
      });

      await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

      expect(judge.requests[0].config?.httpOptions?.retryOptions).toBeDefined();
    });

    it('issues one judge call per sample, and none for the first turn', async () => {
      const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
        threshold: 0.8,
        judgeModelOptions: {numSamples: 3},
      });

      await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

      // Three samples for the second turn, three for the stop-signal turn.
      expect(judge.requests).toHaveLength(6);
    });

    it('puts the default stop signal in the prompt when the criterion omits it', async () => {
      const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
        threshold: 0.8,
        judgeModelOptions: {numSamples: 1},
      });

      await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

      expect(promptOf(judge, 0)).toContain(
        `\`${DEFAULT_USER_SIMULATOR_STOP_SIGNAL}\``,
      );
    });

    it('grades a later turn against the turns before it', async () => {
      const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
        threshold: 0.8,
        judgeModelOptions: {numSamples: 1},
      });

      await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

      const secondTurnPrompt = promptOf(judge, 0);
      expect(secondTurnPrompt).toContain(`user: ${STARTING_PROMPT}`);
      expect(secondTurnPrompt).not.toContain('user: user 2.');
      expect(secondTurnPrompt).toContain('# Generated User Response\nuser 2.');
    });

    it('does not evaluate a turn when the judge answers nothing', async () => {
      const {evaluator} = evaluatorWith([{silent: true}], {
        threshold: 0.8,
        judgeModelOptions: {numSamples: 1},
      });

      const result = await evaluator.evaluateInvocations(
        CONVERSATION,
        undefined,
        SCENARIO,
      );

      expect(result.perInvocationResults[1].score).toBeUndefined();
      expect(result.perInvocationResults[1].evalStatus).toBe(
        EvalStatus.NOT_EVALUATED,
      );
    });

    it('does not evaluate a turn when the criterion asks for no samples', async () => {
      const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
        threshold: 0.8,
        judgeModelOptions: {numSamples: 0},
      });

      const result = await evaluator.evaluateInvocations(
        CONVERSATION,
        undefined,
        SCENARIO,
      );

      expect(judge.requests).toHaveLength(0);
      expect(result.perInvocationResults[1].evalStatus).toBe(
        EvalStatus.NOT_EVALUATED,
      );
    });
  });

  describe('PerTurnUserSimulatorQualityV1 stop-signal turn', () => {
    it('replaces the last turn when the conversation should have ended', async () => {
      const {evaluator} = evaluatorWith(
        // The second turn passes; the stop-signal call that follows it fails.
        [{critique: VALID_CRITIQUE}, {critique: INVALID_CRITIQUE}],
        {threshold: 0.8, judgeModelOptions: {numSamples: 1}},
      );

      const result = await evaluator.evaluateInvocations(
        CONVERSATION,
        undefined,
        SCENARIO,
      );

      expect(result.perInvocationResults).toHaveLength(2);
      expect(result.perInvocationResults[1].actualInvocation.invocationId).toBe(
        'stop_signal_proxy_invocation',
      );
      expect(result.perInvocationResults[1].score).toBe(0.0);
      expect(result.overallScore).toBe(0.5);
      expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
    });

    it('keeps every turn when the conversation ended correctly', async () => {
      const {evaluator} = evaluatorWith([{critique: VALID_CRITIQUE}], {
        threshold: 0.8,
        judgeModelOptions: {numSamples: 1},
      });

      const result = await evaluator.evaluateInvocations(
        CONVERSATION,
        undefined,
        SCENARIO,
      );

      expect(result.perInvocationResults).toHaveLength(2);
      expect(
        result.perInvocationResults.map((r) => r.actualInvocation.invocationId),
      ).toEqual([STARTING_PROMPT, 'user 2.']);
    });

    it('sends the stop signal as the turn the last judge call grades', async () => {
      const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
        threshold: 0.8,
        stopSignal: '<<done>>',
        judgeModelOptions: {numSamples: 1},
      });

      await evaluator.evaluateInvocations(CONVERSATION, undefined, SCENARIO);

      expect(promptOf(judge, judge.requests.length - 1)).toContain(
        '# Generated User Response\n<<done>>',
      );
    });
  });

  describe('PerTurnUserSimulatorQualityV1 input guards', () => {
    it('rejects a call that supplies no conversation scenario', async () => {
      const {evaluator} = evaluatorWith([{critique: VALID_CRITIQUE}], {
        threshold: 0.8,
      });

      await expect(evaluator.evaluateInvocations(CONVERSATION)).rejects.toThrow(
        new InputValidationError(
          'conversationScenario is needed by this metric.',
        ),
      );
    });

    it('evaluates nothing for an empty conversation', async () => {
      const {evaluator, judge} = evaluatorWith([{critique: VALID_CRITIQUE}], {
        threshold: 0.8,
      });

      const result = await evaluator.evaluateInvocations(
        [],
        undefined,
        SCENARIO,
      );

      expect(result).toEqual({
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults: [],
      });
      expect(judge.requests).toHaveLength(0);
    });
  });

  describe('aggregateSamples tie-breaking', () => {
    function scored(score: number | undefined): PerInvocationResult {
      return {
        actualInvocation: CONVERSATION[0],
        score,
        evalStatus:
          score === 1.0
            ? EvalStatus.PASSED
            : score === 0.0
              ? EvalStatus.FAILED
              : EvalStatus.NOT_EVALUATED,
      };
    }

    it('gives a tie to the samples that rejected the turn', () => {
      const aggregated = aggregateSamples([
        scored(1.0),
        scored(1.0),
        scored(0.0),
        scored(0.0),
      ]);

      expect(aggregated.score).toBe(0.0);
      expect(aggregated.evalStatus).toBe(EvalStatus.FAILED);
    });

    it('ignores an unscored sample when other samples voted', () => {
      const aggregated = aggregateSamples([
        scored(undefined),
        scored(1.0),
        scored(0.0),
        scored(1.0),
      ]);

      expect(aggregated.score).toBe(1.0);
    });

    it('rejects an empty sample list', () => {
      expect(() => aggregateSamples([])).toThrow(
        new InputValidationError('No samples to aggregate into a result.'),
      );
    });
  });

  describe('aggregateConversationResults edge cases', () => {
    it('evaluates nothing for an empty result list', () => {
      expect(aggregateConversationResults([], 0.8)).toEqual({
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults: [],
      });
    });

    it('counts a passed turn that carries no score as zero', () => {
      const aggregated = aggregateConversationResults(
        [
          {actualInvocation: CONVERSATION[0], evalStatus: EvalStatus.PASSED},
          {
            actualInvocation: CONVERSATION[1],
            score: 1.0,
            evalStatus: EvalStatus.PASSED,
          },
        ],
        0.4,
      );

      expect(aggregated.overallScore).toBe(0.5);
      expect(aggregated.overallEvalStatus).toBe(EvalStatus.PASSED);
    });
  });

  describe('parseIsValidLabel edge cases', () => {
    it('strips the braces a critique leaves around the verdict', () => {
      expect(parseIsValidLabel('"is_valid": }valid}\n')).toBe(Label.VALID);
    });

    it('reports a critique with no verdict field at all', () => {
      expect(parseIsValidLabel('the judge said nothing useful')).toBe(
        Label.NOT_FOUND,
      );
    });
  });

  describe('convertLlmResponseToScore edge cases', () => {
    it('reads no score out of a response with no content', () => {
      expect(convertLlmResponseToScore({})).toEqual({});
    });
  });

  describe('evaluateFirstTurn whitespace handling', () => {
    it('accepts a starting prompt that differs only in surrounding whitespace', () => {
      const result = evaluateFirstTurn(
        {
          invocationId: '1',
          userContent: {
            role: 'user',
            parts: [{text: `  ${STARTING_PROMPT}\n`}],
          },
        },
        {startingPrompt: `\n${STARTING_PROMPT}  `, conversationPlan: 'plan'},
        1.0,
      );

      expect(result.score).toBe(1);
      expect(result.evalStatus).toBe(EvalStatus.PASSED);
    });

    it('rejects a starting prompt that differs inside the text', () => {
      const result = evaluateFirstTurn(
        {
          invocationId: '1',
          userContent: {role: 'user', parts: [{text: 'first  user prompt.'}]},
        },
        SCENARIO,
        1.0,
      );

      expect(result.score).toBe(0);
      expect(result.evalStatus).toBe(EvalStatus.FAILED);
    });
  });

  describe('formatConversationHistory edge cases', () => {
    it('names the agent role when the reply carries none', () => {
      const history = formatConversationHistory([
        {
          invocationId: '1',
          userContent: {role: 'user', parts: [{text: 'hello'}]},
          finalResponse: {parts: [{text: 'hi'}]},
        },
      ]);

      expect(history).toBe('user: hello\n\nmodel: hi');
    });
  });
});
