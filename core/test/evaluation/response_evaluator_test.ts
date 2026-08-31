/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour of `ResponseEvaluator.evaluate`, translated from adk-python
 * v0.2.0 `tests/unittests/evaluation/test_response_evaluator.py`. Each case
 * names the Python case it comes from.
 *
 * The two criteria the evaluator accepts, as adk-python documents them:
 * `response_match_score` is a ROUGE similarity to a golden reference, in
 * [0, 1]; `response_evaluation_score` is an LLM-judged coherence score, in
 * [0, 5].
 *
 * Python patches the private static `_perform_eval`. adk-js forbids a test
 * reaching a private member, so the evaluation service is an injected
 * `EvalBackend` here.
 *
 * `test_evaluate_none_dataset_raises_value_error` has no translation: it
 * passes `None` for a required list, which `EvalTurn[][]` rejects at compile
 * time. It exercises the same runtime guard as the empty-array case below.
 */

import {
  EvalBackend,
  EvalCriterion,
  EvalDatasetRow,
  EvalRunResult,
  EvalTurn,
  ResponseEvaluator,
  VertexEvalMetric,
} from '@google/adk';
import {logger} from '@google/adk/utils/logger.js';
import {afterEach, describe, expect, it, Mock, vi} from 'vitest';

const SAMPLE_TURN_1_ALL_KEYS: EvalTurn = {
  query: 'query1',
  response: 'response1',
  actualToolUse: [{tool_name: 'tool_a', tool_input: {}}],
  expectedToolUse: [{tool_name: 'tool_a', tool_input: {}}],
  reference: 'reference1',
};

const SAMPLE_TURN_2_MISSING_REF: EvalTurn = {
  query: 'query2',
  response: 'response2',
  actualToolUse: [],
  expectedToolUse: [],
};

const SAMPLE_TURN_3_MISSING_EXP_TOOLS: EvalTurn = {
  query: 'query3',
  response: 'response3',
  actualToolUse: [{tool_name: 'tool_b', tool_input: {}}],
  reference: 'reference3',
};

const SAMPLE_TURN_4_MINIMAL: EvalTurn = {
  query: 'query4',
  response: 'response4',
};

const MOCK_EVAL_RESULT: EvalRunResult = {
  summaryMetrics: {mock_metric: 0.75, another_mock: 3.5},
  metricsTable: [
    {prompt: 'mock_query1', response: 'mock_resp1', mock_metric: 0.75},
  ],
};

const ROW_FROM_TURN_1: EvalDatasetRow = {
  prompt: 'query1',
  response: 'response1',
  actual_tool_use: [{tool_name: 'tool_a', tool_input: {}}],
  reference_trajectory: [{tool_name: 'tool_a', tool_input: {}}],
  reference: 'reference1',
};

interface FakeEvalBackend extends EvalBackend {
  performEval: Mock<EvalBackend['performEval']>;
}

function fakeBackend(): FakeEvalBackend {
  return {
    performEval: vi
      .fn<EvalBackend['performEval']>()
      .mockResolvedValue(MOCK_EVAL_RESULT),
  };
}

/** Asserts the backend ran exactly once and returns that call's arguments. */
function soleCallArgs(
  backend: FakeEvalBackend,
): [EvalDatasetRow[], VertexEvalMetric[]] {
  expect(backend.performEval).toHaveBeenCalledTimes(1);
  const [call] = backend.performEval.mock.calls;
  if (!call) {
    expect.fail('performEval was never called');
  }
  return call;
}

describe('ResponseEvaluator.evaluate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // test_evaluate_empty_dataset_raises_value_error
  it('rejects an empty dataset without calling the backend', async () => {
    const backend = fakeBackend();

    await expect(
      ResponseEvaluator.evaluate(
        [],
        [EvalCriterion.RESPONSE_EVALUATION_SCORE],
        {backend},
      ),
    ).rejects.toThrow('The evaluation dataset is empty.');
    expect(backend.performEval).not.toHaveBeenCalled();
  });

  // test_evaluate_determines_metrics_correctly_for_perform_eval, case 1
  it('selects coherence for response_evaluation_score', async () => {
    const backend = fakeBackend();

    await ResponseEvaluator.evaluate(
      [[SAMPLE_TURN_1_ALL_KEYS]],
      [EvalCriterion.RESPONSE_EVALUATION_SCORE],
      {backend},
    );

    const [, metrics] = soleCallArgs(backend);
    expect(metrics).toEqual([VertexEvalMetric.COHERENCE]);
  });

  // test_evaluate_determines_metrics_correctly_for_perform_eval, case 2.
  // The literal pins the enum's value, exactly as the Python case does.
  it('selects rouge_1 for response_match_score', async () => {
    const backend = fakeBackend();

    await ResponseEvaluator.evaluate(
      [[SAMPLE_TURN_1_ALL_KEYS]],
      [EvalCriterion.RESPONSE_MATCH_SCORE],
      {backend},
    );

    const [, metrics] = soleCallArgs(backend);
    expect(metrics).toEqual(['rouge_1']);
  });

  // test_evaluate_determines_metrics_correctly_for_perform_eval, case 3. The
  // second turn holds every key, so this pins that only the first turn of the
  // first conversation decides the metrics.
  it('selects no metric when the first turn lacks the required keys', async () => {
    const backend = fakeBackend();

    await ResponseEvaluator.evaluate(
      [[SAMPLE_TURN_4_MINIMAL, SAMPLE_TURN_1_ALL_KEYS]],
      [
        EvalCriterion.RESPONSE_EVALUATION_SCORE,
        EvalCriterion.RESPONSE_MATCH_SCORE,
      ],
      {backend},
    );

    const [, metrics] = soleCallArgs(backend);
    expect(metrics).toEqual([]);
  });

  // test_evaluate_determines_metrics_correctly_for_perform_eval, case 4
  it('selects no metric when no criteria are given', async () => {
    const backend = fakeBackend();

    await ResponseEvaluator.evaluate([[SAMPLE_TURN_1_ALL_KEYS]], [], {backend});

    const [, metrics] = soleCallArgs(backend);
    expect(metrics).toEqual([]);
  });

  // test_evaluate_calls_perform_eval_correctly_all_metrics. Metric order
  // matters: Python appends coherence before rouge.
  it('passes both metrics with the prepared dataset and returns the summary metrics', async () => {
    const backend = fakeBackend();

    const summary = await ResponseEvaluator.evaluate(
      [[SAMPLE_TURN_1_ALL_KEYS]],
      [
        EvalCriterion.RESPONSE_EVALUATION_SCORE,
        EvalCriterion.RESPONSE_MATCH_SCORE,
      ],
      {backend},
    );

    const [dataset, metrics] = soleCallArgs(backend);
    expect(dataset).toEqual([ROW_FROM_TURN_1]);
    expect(metrics).toEqual([VertexEvalMetric.COHERENCE, 'rouge_1']);
    expect(summary).toEqual(MOCK_EVAL_RESULT.summaryMetrics);
  });

  // test_evaluate_prepares_dataframe_correctly_for_perform_eval. `toEqual`,
  // not `toStrictEqual`: pandas materialises a missing key as NaN under the
  // union of all columns, while a plain object simply omits it, so pinning
  // `undefined`-vs-absent would assert how the row was built, not behaviour.
  it('flattens every conversation into one row per turn', async () => {
    const backend = fakeBackend();

    await ResponseEvaluator.evaluate(
      [
        [SAMPLE_TURN_1_ALL_KEYS],
        [SAMPLE_TURN_2_MISSING_REF, SAMPLE_TURN_3_MISSING_EXP_TOOLS],
      ],
      [EvalCriterion.RESPONSE_MATCH_SCORE],
      {backend},
    );

    const [dataset] = soleCallArgs(backend);
    expect(dataset).toEqual([
      ROW_FROM_TURN_1,
      {
        prompt: 'query2',
        response: 'response2',
        actual_tool_use: [],
        reference_trajectory: [],
      },
      {
        prompt: 'query3',
        response: 'response3',
        actual_tool_use: [{tool_name: 'tool_b', tool_input: {}}],
        reference: 'reference3',
      },
    ]);
  });

  // test_evaluate_print_detailed_results. Python asserts `_print_results` got
  // the backend's result object; the logged text carries the same proof.
  it('logs the detailed results when printDetailedResults is true', async () => {
    const backend = fakeBackend();
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    await ResponseEvaluator.evaluate(
      [[SAMPLE_TURN_1_ALL_KEYS]],
      [EvalCriterion.RESPONSE_MATCH_SCORE],
      {printDetailedResults: true, backend},
    );

    expect(backend.performEval).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [loggedArgs] = infoSpy.mock.calls;
    if (!loggedArgs) {
      expect.fail('logger.info was never called');
    }
    const logged = loggedArgs.join(' ');
    expect(logged).toContain('mock_metric');
    expect(logged).toContain('0.75');
  });

  // test_evaluate_no_print_detailed_results
  it('does not log the detailed results when printDetailedResults is false', async () => {
    const backend = fakeBackend();
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});

    await ResponseEvaluator.evaluate(
      [[SAMPLE_TURN_1_ALL_KEYS]],
      [EvalCriterion.RESPONSE_MATCH_SCORE],
      {printDetailedResults: false, backend},
    );

    expect(backend.performEval).toHaveBeenCalledTimes(1);
    expect(infoSpy).not.toHaveBeenCalled();
  });
});

// Not translated from Python: adk-python reads `raw_eval_dataset[0][0]` after
// its guard, so a dataset holding only empty sessions raises IndexError there.
// adk-js reports the same dataset with the same message instead.
describe('ResponseEvaluator.evaluate, beyond the translated cases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a dataset whose only session has no turns', async () => {
    const backend = fakeBackend();

    await expect(
      ResponseEvaluator.evaluate([[]], [EvalCriterion.RESPONSE_MATCH_SCORE], {
        backend,
      }),
    ).rejects.toThrow('The evaluation dataset is empty.');
    expect(backend.performEval).not.toHaveBeenCalled();
  });
});
