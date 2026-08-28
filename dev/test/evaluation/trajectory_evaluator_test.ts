/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EvalTurn} from '../../src/evaluation/eval_types.js';
import {
  areToolsEqual,
  evaluateTrajectory,
  stripMockToolOutputs,
} from '../../src/evaluation/trajectory_evaluator.js';

/** Builds a turn whose expected and actual trajectories are given explicitly. */
function turn(overrides: Partial<EvalTurn> & {query: string}): EvalTurn {
  return {actual_tool_use: [], ...overrides};
}

describe('areToolsEqual', () => {
  it('matches identical trajectories', () => {
    expect(
      areToolsEqual(
        [{tool_name: 'roll_die', tool_input: {sides: 6}}],
        [{tool_name: 'roll_die', tool_input: {sides: 6}}],
      ),
    ).toBe(true);
  });

  it('rejects the same calls in a different order', () => {
    expect(
      areToolsEqual(
        [
          {tool_name: 'a', tool_input: {}},
          {tool_name: 'b', tool_input: {}},
        ],
        [
          {tool_name: 'b', tool_input: {}},
          {tool_name: 'a', tool_input: {}},
        ],
      ),
    ).toBe(false);
  });

  it('rejects a different tool_input', () => {
    expect(
      areToolsEqual(
        [{tool_name: 'roll_die', tool_input: {sides: 6}}],
        [{tool_name: 'roll_die', tool_input: {sides: 20}}],
      ),
    ).toBe(false);
  });

  it('ignores mock_tool_output on the expected side', () => {
    expect(
      areToolsEqual(
        [{tool_name: 'roll_die', tool_input: {sides: 6}}],
        [{tool_name: 'roll_die', tool_input: {sides: 6}, mock_tool_output: 4}],
      ),
    ).toBe(true);
  });

  it('reads a missing tool_input as an empty object', () => {
    expect(
      areToolsEqual([{tool_name: 'now', tool_input: {}}], [{tool_name: 'now'}]),
    ).toBe(true);
  });

  it('rejects trajectories of different lengths', () => {
    expect(areToolsEqual([{tool_name: 'a', tool_input: {}}], [])).toBe(false);
  });

  it('matches two empty trajectories', () => {
    expect(areToolsEqual([], [])).toBe(true);
  });
});

describe('stripMockToolOutputs', () => {
  it('drops mock_tool_output and keeps the rest', () => {
    expect(
      stripMockToolOutputs([
        {tool_name: 'roll_die', tool_input: {sides: 6}, mock_tool_output: 4},
      ]),
    ).toEqual([{tool_name: 'roll_die', tool_input: {sides: 6}}]);
  });
});

describe('evaluateTrajectory', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scores 1 when every turn matches', () => {
    const score = evaluateTrajectory([
      turn({
        query: 'roll',
        expected_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
        actual_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
      }),
    ]);

    expect(score).toBe(1);
  });

  it('scores 0 when no turn matches', () => {
    const score = evaluateTrajectory([
      turn({
        query: 'roll',
        expected_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
        actual_tool_use: [],
      }),
    ]);

    expect(score).toBe(0);
  });

  it('averages a matching and a non-matching turn to 0.5', () => {
    const score = evaluateTrajectory([
      turn({
        query: 'first',
        expected_tool_use: [{tool_name: 'a', tool_input: {}}],
        actual_tool_use: [{tool_name: 'a', tool_input: {}}],
      }),
      turn({
        query: 'second',
        expected_tool_use: [{tool_name: 'b', tool_input: {}}],
        actual_tool_use: [],
      }),
    ]);

    expect(score).toBe(0.5);
  });

  it('treats a missing expected_tool_use as no expected calls', () => {
    const score = evaluateTrajectory([turn({query: 'hello'})]);

    expect(score).toBe(1);
  });

  it('treats a missing actual_tool_use as no recorded calls', () => {
    expect(evaluateTrajectory([{query: 'hello'}])).toBe(1);
    expect(
      evaluateTrajectory([
        {query: 'roll', expected_tool_use: [{tool_name: 'a'}]},
      ]),
    ).toBe(0);
  });

  it('averages over every turn of the case', () => {
    const matching = turn({
      query: 'ok',
      expected_tool_use: [{tool_name: 'a', tool_input: {}}],
      actual_tool_use: [{tool_name: 'a', tool_input: {}}],
    });
    const failing = turn({
      query: 'bad',
      expected_tool_use: [{tool_name: 'b', tool_input: {}}],
      actual_tool_use: [],
    });

    // Three turns, one of which fails.
    expect(evaluateTrajectory([matching, matching, failing])).toBeCloseTo(
      2 / 3,
    );
  });

  it('scores a case with no turns as 0 rather than NaN', () => {
    expect(evaluateTrajectory([])).toBe(0);
  });

  it('reports the turn number, query, actual and expected of a failure', () => {
    evaluateTrajectory([
      turn({
        query: 'ok',
        expected_tool_use: [{tool_name: 'a', tool_input: {}}],
        actual_tool_use: [{tool_name: 'a', tool_input: {}}],
      }),
      turn({
        query: 'roll a die',
        expected_tool_use: [
          {
            tool_name: 'roll_die',
            tool_input: {sides: 6},
            mock_tool_output: 4,
          },
        ],
        actual_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 20}}],
      }),
    ]);

    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('Failures:');
    expect(printed).toContain('"turn": 2');
    expect(printed).toContain('"query": \'roll a die\'');
    expect(printed).toContain(
      '"actual": [{"tool_name":"roll_die","tool_input":{"sides":20}}]',
    );
    expect(printed).toContain(
      '"expected_tool_use": [{"tool_name":"roll_die","tool_input":{"sides":6}}]',
    );
  });

  it('prints no failure report when every turn passes', () => {
    evaluateTrajectory([
      turn({
        query: 'ok',
        expected_tool_use: [{tool_name: 'a', tool_input: {}}],
        actual_tool_use: [{tool_name: 'a', tool_input: {}}],
      }),
    ]);

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('prints the detail table only when asked', () => {
    const turns = [
      turn({
        query: 'roll',
        expected_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
        actual_tool_use: [{tool_name: 'roll_die', tool_input: {sides: 6}}],
        response: 'I rolled a 4.',
      }),
    ];

    evaluateTrajectory(turns);
    expect(logSpy).not.toHaveBeenCalled();

    evaluateTrajectory(turns, {printDetailedResults: true});

    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain('query');
    expect(printed).toContain('expected_tool_use');
    expect(printed).toContain('actual_tool_use');
    expect(printed).toContain('score');
    expect(printed).toContain('roll_die');
  });

  it('keeps the columns aligned when a trajectory is long', () => {
    const longName = 'a_tool_with_a_rather_long_name_that_exceeds_the_header';
    evaluateTrajectory(
      [
        turn({
          query: 'roll',
          expected_tool_use: [{tool_name: longName, tool_input: {}}],
          actual_tool_use: [{tool_name: longName, tool_input: {}}],
        }),
      ],
      {printDetailedResults: true},
    );

    const lines = logSpy.mock.calls.map((call) => String(call[0]));
    const separatorIndex = lines.findIndex((line) => /^-+$/.test(line));
    expect(separatorIndex).toBeGreaterThan(0);
    const dividerOffsets = (line: string) =>
      [...line.matchAll(/\|/g)].map((match) => match.index);

    // Every column divider sits at the same offset on the header and the row.
    expect(dividerOffsets(lines[separatorIndex + 1])).toEqual(
      dividerOffsets(lines[separatorIndex - 1]),
    );
  });
});
