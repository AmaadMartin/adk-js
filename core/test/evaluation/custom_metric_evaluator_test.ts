/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CustomMetricEvaluator,
  getConfigCustomFunctionPath,
  getMetricFunction,
  isInputValidationError,
  setConfigCustomFunctionPath,
  type ConversationScenario,
  type EvalMetric,
  type Invocation,
} from '@google/adk';
import {fileURLToPath} from 'node:url';
import {beforeEach, describe, expect, it} from 'vitest';
import {
  ASYNC_SCORE,
  DEFAULT_EXPORT_SCORE,
  SYNC_SCORE,
  recordedCalls,
  type RecordedCall,
} from './fixtures/custom_metrics.js';

/** Absolute path of the fixture module standing in for user scoring code. */
const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/custom_metrics.ts', import.meta.url),
);

/**
 * The base a relative specifier resolves against. The resolver reads only the
 * directory part, so any real file in the fixtures directory serves.
 */
const CONFIG_PATH = FIXTURE_PATH;

const RECORDING_PATH = `${FIXTURE_PATH}#recordingMetric`;
const MUTATING_PATH = `${FIXTURE_PATH}#mutatingMetric`;

function metricWithCriterion(): EvalMetric {
  return {
    metricName: 'brand_voice',
    threshold: 0.7,
    criterion: {threshold: 0.8},
  };
}

function invocation(text: string): Invocation {
  return {
    invocationId: text,
    userContent: {role: 'user', parts: [{text}]},
  };
}

/** Runs the recording fixture and returns the single call it recorded. */
async function runRecording(
  evalMetric: EvalMetric,
  expectedInvocations?: Invocation[],
  conversationScenario?: ConversationScenario,
): Promise<RecordedCall> {
  const evaluator = new CustomMetricEvaluator(evalMetric, RECORDING_PATH);

  await evaluator.evaluateInvocations(
    [invocation('actual')],
    expectedInvocations,
    conversationScenario,
  );

  const call = recordedCalls.at(-1);
  if (call === undefined) {
    expect.fail('the scoring function was not called');
  }
  return call;
}

beforeEach(() => {
  recordedCalls.length = 0;
});

describe('CustomMetricEvaluator', () => {
  it('clears the deprecated metric-level threshold on the copy', async () => {
    const call = await runRecording(metricWithCriterion());

    expect(call.evalMetric.threshold).toBeUndefined();
  });

  it('leaves the criterion threshold in place on the copy', async () => {
    const call = await runRecording(metricWithCriterion());

    expect(call.evalMetric.criterion?.threshold).toBe(0.8);
  });

  it('does not clear the threshold on the caller metric', async () => {
    const evalMetric = metricWithCriterion();

    await runRecording(evalMetric);

    expect(evalMetric.threshold).toBe(0.7);
  });

  it('deep-copies, so a function writing to the criterion cannot reach the caller metric', async () => {
    const evalMetric = metricWithCriterion();
    const evaluator = new CustomMetricEvaluator(evalMetric, MUTATING_PATH);

    await evaluator.evaluateInvocations([]);

    expect(evalMetric.criterion?.threshold).toBe(0.8);
    expect(evalMetric.metricName).toBe('brand_voice');
  });

  it('carries a config-declared function path onto the copy', async () => {
    const evalMetric = metricWithCriterion();
    setConfigCustomFunctionPath(evalMetric, RECORDING_PATH);

    const call = await runRecording(evalMetric);

    expect(getConfigCustomFunctionPath(call.evalMetric)).toBe(RECORDING_PATH);
  });

  it('records no function path on the copy when the config declared none', async () => {
    const call = await runRecording(metricWithCriterion());

    expect(getConfigCustomFunctionPath(call.evalMetric)).toBeUndefined();
  });

  it('forwards the invocations and the scenario by identity', async () => {
    const actualInvocations = [invocation('actual')];
    const expectedInvocations = [invocation('expected')];
    const conversationScenario: ConversationScenario = {
      startingPrompt: 'I need to book a flight.',
      conversationPlan: 'Book a one-way flight, then confirm it.',
    };
    const evaluator = new CustomMetricEvaluator(
      metricWithCriterion(),
      RECORDING_PATH,
    );

    await evaluator.evaluateInvocations(
      actualInvocations,
      expectedInvocations,
      conversationScenario,
    );

    const call = recordedCalls.at(-1);
    if (call === undefined) {
      expect.fail('the scoring function was not called');
    }
    expect(call.actualInvocations).toBe(actualInvocations);
    expect(call.expectedInvocations).toBe(expectedInvocations);
    expect(call.conversationScenario).toBe(conversationScenario);
  });

  it('reuses the resolved function across calls, copying the metric each time', async () => {
    const evalMetric = metricWithCriterion();
    const evaluator = new CustomMetricEvaluator(evalMetric, RECORDING_PATH);

    await evaluator.evaluateInvocations([]);
    await evaluator.evaluateInvocations([]);

    expect(recordedCalls).toHaveLength(2);
    expect(recordedCalls[0].evalMetric).not.toBe(recordedCalls[1].evalMetric);
    expect(recordedCalls[0].evalMetric).not.toBe(evalMetric);
  });

  it('reports the same failure on a second call', async () => {
    const evaluator = new CustomMetricEvaluator(
      metricWithCriterion(),
      `${FIXTURE_PATH}#no_such_export`,
    );

    await expect(evaluator.evaluateInvocations([])).rejects.toThrow(
      /Could not import custom metric function/,
    );
    await expect(evaluator.evaluateInvocations([])).rejects.toThrow(
      /Could not import custom metric function/,
    );
  });

  it('returns the resolved value of an async scoring function', async () => {
    const evaluator = new CustomMetricEvaluator(
      metricWithCriterion(),
      `${FIXTURE_PATH}#asyncMetric`,
    );

    const result = await evaluator.evaluateInvocations([]);

    expect(result.overallScore).toBe(ASYNC_SCORE);
  });

  it('resolves a relative specifier against the base file path', async () => {
    const evaluator = new CustomMetricEvaluator(
      metricWithCriterion(),
      './custom_metrics.ts#syncMetric',
      CONFIG_PATH,
    );

    const result = await evaluator.evaluateInvocations([]);

    expect(result.overallScore).toBe(SYNC_SCORE);
  });
});

describe('getMetricFunction', () => {
  it('reads the default export when the name has no export part', async () => {
    const metricFunction = await getMetricFunction(FIXTURE_PATH);

    expect((await metricFunction({metricName: 'm'}, [])).overallScore).toBe(
      DEFAULT_EXPORT_SCORE,
    );
  });

  it('reads the default export when nothing follows the separator', async () => {
    const metricFunction = await getMetricFunction(`${FIXTURE_PATH}#`);

    expect((await metricFunction({metricName: 'm'}, [])).overallScore).toBe(
      DEFAULT_EXPORT_SCORE,
    );
  });

  it('rejects a specifier that will not import, keeping the cause', async () => {
    const path = `${FIXTURE_PATH}.missing.ts#syncMetric`;

    const error = await getMetricFunction(path).catch((e: unknown) => e);

    if (!isInputValidationError(error)) {
      expect.fail(`expected an InputValidationError, got ${String(error)}`);
    }
    expect(error.message).toBe(
      `Could not import custom metric function from ${path}`,
    );
    expect(error.cause).toBeDefined();
  });

  it('rejects an export that is not a function', async () => {
    const path = `${FIXTURE_PATH}#notAFunction`;

    const error = await getMetricFunction(path).catch((e: unknown) => e);

    if (!isInputValidationError(error)) {
      expect.fail(`expected an InputValidationError, got ${String(error)}`);
    }
    expect(error.message).toBe(
      `Custom metric ${path} does not refer to a callable.`,
    );
    expect(error.cause).toBeUndefined();
  });

  it('rejects a Node built-in specifier', async () => {
    const path = 'node:fs#readFileSync';

    const error = await getMetricFunction(path).catch((e: unknown) => e);

    if (!isInputValidationError(error)) {
      expect.fail(`expected an InputValidationError, got ${String(error)}`);
    }
    expect(error.message).toBe(
      `Could not import custom metric function from ${path}`,
    );
  });

  it('rejects a specifier carrying a URL scheme', async () => {
    const path = 'data:text/javascript,export default () => 1';

    const error = await getMetricFunction(path).catch((e: unknown) => e);

    if (!isInputValidationError(error)) {
      expect.fail(`expected an InputValidationError, got ${String(error)}`);
    }
    expect(error.message).toBe(
      `Could not import custom metric function from ${path}`,
    );
  });

  it('rejects a relative specifier when no base file path is given', async () => {
    const path = './custom_metrics.ts#syncMetric';

    const error = await getMetricFunction(path).catch((e: unknown) => e);

    if (!isInputValidationError(error)) {
      expect.fail(`expected an InputValidationError, got ${String(error)}`);
    }
    expect(error.message).toBe(
      `Could not import custom metric function from ${path}`,
    );
  });
});
