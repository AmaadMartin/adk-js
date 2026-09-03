/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalCaseResult, EvalStatus, Invocation} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  printDetailedEvalResult,
  printEvalRunSummary,
} from '../../src/cli/eval_result_printer.js';

let printed: string[];

function invocation(prompt: string, response: string): Invocation {
  return {
    userContent: {role: 'user', parts: [{text: prompt}]},
    finalResponse: {role: 'model', parts: [{text: response}]},
    intermediateData: {
      toolUses: [{name: 'set_lights', args: {on: true}}],
      toolResponses: [],
      intermediateResponses: [],
    },
  };
}

function result(overrides: Partial<EvalCaseResult> = {}): EvalCaseResult {
  return {
    evalSetId: 'smoke',
    evalId: 'lights_on',
    finalEvalStatus: EvalStatus.PASSED,
    evalMetricResultPerInvocation: [],
    sessionId: 'lights_on_session',
    ...overrides,
  };
}

beforeEach(() => {
  printed = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('printEvalRunSummary', () => {
  it('counts the passed and failed cases of each eval set', () => {
    printEvalRunSummary([
      result(),
      result({evalId: 'lights_off', finalEvalStatus: EvalStatus.FAILED}),
      result({
        evalSetId: 'other',
        finalEvalStatus: EvalStatus.NOT_EVALUATED,
      }),
    ]);

    expect(printed).toEqual([
      '*'.repeat(69),
      'Eval Run Summary',
      'smoke:\n  Tests passed: 1\n  Tests failed: 1',
      'other:\n  Tests passed: 0\n  Tests failed: 1',
    ]);
  });

  it('prints the header alone for a run with no results', () => {
    printEvalRunSummary([]);

    expect(printed).toEqual(['*'.repeat(69), 'Eval Run Summary']);
  });
});

describe('printDetailedEvalResult', () => {
  it('prints the verdict of each metric of the eval case', () => {
    printDetailedEvalResult(
      result({
        overallEvalMetricResults: [
          {
            metricName: 'response_match_score',
            criterion: {threshold: 0.8},
            score: 0.9,
            evalStatus: EvalStatus.PASSED,
          },
          {
            metricName: 'tool_trajectory_avg_score',
            threshold: 1,
            score: 0.5,
            evalStatus: EvalStatus.FAILED,
          },
        ],
      }),
    );

    const output = printed.join('\n');
    expect(output).toContain('Eval Set Id: smoke');
    expect(output).toContain('Eval Id: lights_on');
    expect(output).toContain('Overall Eval Status: PASSED');
    expect(output).toContain(
      'Metric: response_match_score, Status: PASSED, Score: 0.9, ' +
        'Threshold: 0.8',
    );
    expect(output).toContain(
      'Metric: tool_trajectory_avg_score, Status: FAILED, Score: 0.5, ' +
        'Threshold: 1',
    );
  });

  it('prints no invocation table when the case has no invocations', () => {
    printDetailedEvalResult(result());

    expect(printed.join('\n')).not.toContain('Invocation Details:');
  });

  it('renders one table row per invocation, with a column per metric', () => {
    printDetailedEvalResult(
      result({
        evalMetricResultPerInvocation: [
          {
            actualInvocation: invocation('Lights on', 'Done.'),
            expectedInvocation: invocation('Lights on', 'Turned them on.'),
            evalMetricResults: [
              {
                metricName: 'response_match_score',
                score: 1,
                evalStatus: EvalStatus.PASSED,
              },
            ],
          },
        ],
      }),
    );

    const output = printed.join('\n');
    expect(output).toContain('Invocation Details:');
    expect(output).toContain('prompt');
    expect(output).toContain('expected_response');
    expect(output).toContain('actual_tool_calls');
    expect(output).toContain('response_match_score');
    expect(output).toContain('Status: PASSED, Score: 1');
    expect(output).toContain('{"name":"set_lights"');
  });

  it('renders an empty cell for an invocation with no final response', () => {
    printDetailedEvalResult(
      result({
        evalMetricResultPerInvocation: [
          {
            actualInvocation: {
              userContent: {role: 'user', parts: [{text: 'Lights on'}]},
            },
            evalMetricResults: [],
          },
        ],
      }),
    );

    expect(printed.join('\n')).toContain('actual_response');
  });

  it('drops the expected columns when no invocation has them', () => {
    printDetailedEvalResult(
      result({
        evalMetricResultPerInvocation: [
          {
            actualInvocation: invocation('Lights on', 'Done.'),
            evalMetricResults: [],
          },
        ],
      }),
    );

    const output = printed.join('\n');
    expect(output).toContain('actual_response');
    expect(output).not.toContain('expected_response');
    expect(output).not.toContain('expected_tool_calls');
  });
});
