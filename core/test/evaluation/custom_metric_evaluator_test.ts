/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CustomMetricEvaluator,
  EvalMetric,
  EvalStatus,
  EvaluationResult,
  Invocation,
} from '@google/adk';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import {beforeEach, describe, expect, it} from 'vitest';

const METRIC: EvalMetric = {
  metricName: 'my_custom_metric',
  threshold: 0.8,
  criterion: {threshold: 0.8},
};

function createInvocation(text: string): Invocation {
  return {
    invocationId: 'inv-1',
    userContent: {role: 'user', parts: [{text}]},
  };
}

/**
 * A metric module that records the metric it was called with, so a test can
 * assert what the evaluator handed over.
 */
const RECORDING_MODULE = `
export const calls = [];

export function score(evalMetric, actualInvocations, expectedInvocations) {
  calls.push({evalMetric, actualInvocations, expectedInvocations});
  return {
    overallScore: 0.5,
    overallEvalStatus: 1,
    perInvocationResults: [],
  };
}

export async function asyncScore() {
  return {overallScore: 0.25, overallEvalStatus: 1, perInvocationResults: []};
}

export default function defaultScore() {
  return {overallScore: 0.75, overallEvalStatus: 1, perInvocationResults: []};
}

export const notAFunction = 'this is a string';
`;

describe('CustomMetricEvaluator', () => {
  let workDir: string;
  let moduleUrl: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'adk-custom-metric-'));
    const modulePath = path.join(workDir, 'metrics.mjs');
    await writeFile(modulePath, RECORDING_MODULE, 'utf-8');
    moduleUrl = pathToFileURL(modulePath).href;
  });

  it('calls the named export and returns its result', async () => {
    const evaluator = new CustomMetricEvaluator(METRIC, `${moduleUrl}#score`);

    const result = await evaluator.evaluateInvocations([
      createInvocation('what is the weather?'),
    ]);

    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('clears the threshold on the metric it hands to the function', async () => {
    const evaluator = new CustomMetricEvaluator(METRIC, `${moduleUrl}#score`);
    const actual = [createInvocation('what is the weather?')];
    const expected = [createInvocation('what is the weather?')];

    await evaluator.evaluateInvocations(actual, expected);

    const module: {calls: Array<{evalMetric: EvalMetric}>} = await import(
      moduleUrl
    );
    expect(module.calls).toHaveLength(1);
    expect(module.calls[0].evalMetric).toEqual({
      metricName: 'my_custom_metric',
      criterion: {threshold: 0.8},
    });
    expect(METRIC.threshold).toBe(0.8);
  });

  it('forwards the invocations and the conversation scenario', async () => {
    const evaluator = new CustomMetricEvaluator(METRIC, `${moduleUrl}#score`);
    const actual = [createInvocation('actual')];
    const expected = [createInvocation('expected')];

    await evaluator.evaluateInvocations(actual, expected);

    const module: {
      calls: Array<{
        actualInvocations: Invocation[];
        expectedInvocations?: Invocation[];
      }>;
    } = await import(moduleUrl);
    expect(module.calls[0].actualInvocations).toBe(actual);
    expect(module.calls[0].expectedInvocations).toBe(expected);
  });

  it('awaits a function that returns a promise', async () => {
    const evaluator = new CustomMetricEvaluator(
      METRIC,
      `${moduleUrl}#asyncScore`,
    );

    const result: EvaluationResult = await evaluator.evaluateInvocations([]);

    expect(result.overallScore).toBe(0.25);
  });

  it('uses the default export when the path names no export', async () => {
    const evaluator = new CustomMetricEvaluator(METRIC, moduleUrl);

    const result = await evaluator.evaluateInvocations([]);

    expect(result.overallScore).toBe(0.75);
  });

  it('rejects a specifier that will not import, naming the path', async () => {
    const missing = pathToFileURL(path.join(workDir, 'absent.mjs')).href;
    const evaluator = new CustomMetricEvaluator(METRIC, `${missing}#score`);

    await expect(evaluator.evaluateInvocations([])).rejects.toThrowError(
      `Could not import custom metric function from ${missing}#score`,
    );
  });

  it('keeps the import failure as the cause', async () => {
    const missing = pathToFileURL(path.join(workDir, 'absent.mjs')).href;
    const evaluator = new CustomMetricEvaluator(METRIC, `${missing}#score`);

    const failure = await evaluator
      .evaluateInvocations([])
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });

  it('rejects an export that is not a function, naming the path', async () => {
    const evaluator = new CustomMetricEvaluator(
      METRIC,
      `${moduleUrl}#notAFunction`,
    );

    await expect(evaluator.evaluateInvocations([])).rejects.toThrowError(
      `Custom metric ${moduleUrl}#notAFunction does not refer to a callable.`,
    );
  });

  it('rejects a path naming an export the module does not have', async () => {
    const evaluator = new CustomMetricEvaluator(METRIC, `${moduleUrl}#absent`);

    await expect(evaluator.evaluateInvocations([])).rejects.toThrowError(
      'does not refer to a callable',
    );
  });
});

describe('CustomMetricEvaluator specifier resolution', () => {
  let modulePath: string;

  beforeEach(async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'adk-custom-metric-'));
    modulePath = path.join(workDir, 'metrics.mjs');
    await writeFile(modulePath, RECORDING_MODULE, 'utf-8');
  });

  it('resolves an absolute file path that carries no URL scheme', async () => {
    const evaluator = new CustomMetricEvaluator(METRIC, `${modulePath}#score`);

    const result = await evaluator.evaluateInvocations([]);

    expect(result.overallScore).toBe(0.5);
  });

  it('reports the working directory as the base it tried', async () => {
    const evaluator = new CustomMetricEvaluator(METRIC, './absent.mjs#score');
    const expected = pathToFileURL(path.join(process.cwd(), 'absent.mjs')).href;

    await expect(evaluator.evaluateInvocations([])).rejects.toThrowError(
      `Could not import custom metric function from ./absent.mjs#score ` +
        `(tried ${expected})`,
    );
  });

  it('leaves a bare specifier to Node package resolution', async () => {
    const evaluator = new CustomMetricEvaluator(METRIC, 'absent-package#score');

    await expect(evaluator.evaluateInvocations([])).rejects.toThrowError(
      '(tried absent-package)',
    );
  });
});
