/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  areToolsEqual,
  EvalTurn,
  evaluateTrajectory,
  InputValidationError,
  ToolUse,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const TOOL_ROLL_DICE_16: ToolUse = {
  toolName: 'rollDie',
  toolInput: {sides: 16},
};
const TOOL_ROLL_DICE_6: ToolUse = {toolName: 'rollDie', toolInput: {sides: 6}};
const TOOL_GET_WEATHER: ToolUse = {
  toolName: 'getWeather',
  toolInput: {location: 'Paris'},
};
const TOOL_GET_WEATHER_SF: ToolUse = {
  toolName: 'getWeather',
  toolInput: {location: 'SF'},
};

const TURN_MATCH: EvalTurn = {
  query: 'Q1',
  response: 'R1',
  actualToolUse: [TOOL_ROLL_DICE_16],
  expectedToolUse: [TOOL_ROLL_DICE_16],
};
const TURN_MISMATCH_INPUT: EvalTurn = {
  query: 'Q2',
  response: 'R2',
  actualToolUse: [TOOL_ROLL_DICE_6],
  expectedToolUse: [TOOL_ROLL_DICE_16],
};
const TURN_MISMATCH_NAME: EvalTurn = {
  query: 'Q3',
  response: 'R3',
  actualToolUse: [TOOL_GET_WEATHER],
  expectedToolUse: [TOOL_ROLL_DICE_16],
};
const TURN_MATCH_MULTIPLE: EvalTurn = {
  query: 'Q4',
  response: 'R4',
  actualToolUse: [TOOL_GET_WEATHER, TOOL_ROLL_DICE_6],
  expectedToolUse: [TOOL_GET_WEATHER, TOOL_ROLL_DICE_6],
};
const TURN_MISMATCH_ORDER: EvalTurn = {
  query: 'Q5',
  response: 'R5',
  actualToolUse: [TOOL_ROLL_DICE_6, TOOL_GET_WEATHER],
  expectedToolUse: [TOOL_GET_WEATHER, TOOL_ROLL_DICE_6],
};
const TURN_MISMATCH_LENGTH_ACTUAL_LONGER: EvalTurn = {
  query: 'Q6',
  response: 'R6',
  actualToolUse: [TOOL_GET_WEATHER, TOOL_ROLL_DICE_6],
  expectedToolUse: [TOOL_GET_WEATHER],
};
const TURN_MISMATCH_LENGTH_EXPECTED_LONGER: EvalTurn = {
  query: 'Q7',
  response: 'R7',
  actualToolUse: [TOOL_GET_WEATHER],
  expectedToolUse: [TOOL_GET_WEATHER, TOOL_ROLL_DICE_6],
};
const TURN_MATCH_WITH_MOCK_OUTPUT: EvalTurn = {
  query: 'Q8',
  response: 'R8',
  actualToolUse: [TOOL_GET_WEATHER_SF],
  expectedToolUse: [{...TOOL_GET_WEATHER_SF, mockToolOutput: 'Sunny'}],
};
const TURN_MATCH_EMPTY_TOOLS: EvalTurn = {
  query: 'Q9',
  response: 'R9',
  actualToolUse: [],
  expectedToolUse: [],
};
const TURN_MISMATCH_EMPTY_VS_NONEMPTY: EvalTurn = {
  query: 'Q10',
  response: 'R10',
  actualToolUse: [],
  expectedToolUse: [TOOL_GET_WEATHER],
};

/** A tool call a caller has annotated with a property of its own. */
interface AnnotatedToolUse extends ToolUse {
  recordedBy: string;
}

const TOOL_GET_WEATHER_ANNOTATED: AnnotatedToolUse = {
  toolName: 'getWeather',
  toolInput: {location: 'Paris'},
  recordedBy: 'replayer',
};

describe('evaluateTrajectory', () => {
  it('rejects an undefined dataset', () => {
    expect(() => evaluateTrajectory(undefined)).toThrow(InputValidationError);
    expect(() => evaluateTrajectory(undefined)).toThrow(
      'The evaluation dataset is empty.',
    );
  });

  it('rejects a null dataset', () => {
    expect(() => evaluateTrajectory(null)).toThrow(InputValidationError);
    expect(() => evaluateTrajectory(null)).toThrow(
      'The evaluation dataset is empty.',
    );
  });

  it('rejects an empty dataset', () => {
    expect(() => evaluateTrajectory([])).toThrow(InputValidationError);
    expect(() => evaluateTrajectory([])).toThrow(
      'The evaluation dataset is empty.',
    );
  });

  it('scores a single matching turn 1', () => {
    expect(evaluateTrajectory([[TURN_MATCH]]).meanToolUseAccuracy).toBe(1);
  });

  it('scores a turn with a different tool input 0', () => {
    expect(
      evaluateTrajectory([[TURN_MISMATCH_INPUT]]).meanToolUseAccuracy,
    ).toBe(0);
  });

  it('scores 1 when every turn of a conversation matches', () => {
    const result = evaluateTrajectory([
      [TURN_MATCH, TURN_MATCH_MULTIPLE, TURN_MATCH_EMPTY_TOOLS],
    ]);

    expect(result.meanToolUseAccuracy).toBe(1);
    expect(result.turnResults).toHaveLength(3);
  });

  it('averages matching and non-matching turns', () => {
    const result = evaluateTrajectory([
      [
        TURN_MATCH,
        TURN_MISMATCH_NAME,
        TURN_MATCH_MULTIPLE,
        TURN_MISMATCH_ORDER,
      ],
    ]);

    expect(result.meanToolUseAccuracy).toBe(0.5);
  });

  it('averages over turns, not over conversations', () => {
    const result = evaluateTrajectory([
      [TURN_MATCH, TURN_MISMATCH_INPUT],
      [TURN_MATCH_MULTIPLE],
      [TURN_MISMATCH_ORDER, TURN_MISMATCH_LENGTH_ACTUAL_LONGER, TURN_MATCH],
    ]);

    expect(result.turnResults).toHaveLength(6);
    expect(result.meanToolUseAccuracy).toBe(0.5);
  });

  it('scores 0 when the actual trajectory is longer than expected', () => {
    expect(
      evaluateTrajectory([[TURN_MISMATCH_LENGTH_ACTUAL_LONGER]])
        .meanToolUseAccuracy,
    ).toBe(0);
  });

  it('scores 0 when the expected trajectory is longer than actual', () => {
    expect(
      evaluateTrajectory([[TURN_MISMATCH_LENGTH_EXPECTED_LONGER]])
        .meanToolUseAccuracy,
    ).toBe(0);
  });

  it('ignores mockToolOutput carried on an expected call', () => {
    expect(
      evaluateTrajectory([[TURN_MATCH_WITH_MOCK_OUTPUT]]).meanToolUseAccuracy,
    ).toBe(1);
  });

  it('scores two empty trajectories 1', () => {
    expect(
      evaluateTrajectory([[TURN_MATCH_EMPTY_TOOLS]]).meanToolUseAccuracy,
    ).toBe(1);
  });

  it('scores an empty trajectory against a non-empty one 0, both ways', () => {
    expect(
      evaluateTrajectory([[TURN_MISMATCH_EMPTY_VS_NONEMPTY]])
        .meanToolUseAccuracy,
    ).toBe(0);

    const reversed: EvalTurn = {
      ...TURN_MISMATCH_EMPTY_VS_NONEMPTY,
      actualToolUse: [TOOL_GET_WEATHER],
      expectedToolUse: [],
    };
    expect(evaluateTrajectory([[reversed]]).meanToolUseAccuracy).toBe(0);
  });

  it('lets an empty conversation contribute no turn', () => {
    const result = evaluateTrajectory([[TURN_MATCH], []]);

    expect(result.meanToolUseAccuracy).toBe(1);
    expect(result.turnResults).toHaveLength(1);
  });

  it('returns NaN when the dataset holds no turn at all', () => {
    const result = evaluateTrajectory([[]]);

    expect(Number.isNaN(result.meanToolUseAccuracy)).toBe(true);
    expect(result.turnResults).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
  });

  it('reports each failing turn with its position and trajectories', () => {
    const result = evaluateTrajectory([[TURN_MATCH, TURN_MISMATCH_INPUT]]);

    expect(result.failures).toEqual([
      {
        conversationIndex: 0,
        turn: 2,
        query: 'Q2',
        actual: [TOOL_ROLL_DICE_6],
        expected: [TOOL_ROLL_DICE_16],
      },
    ]);
  });

  it('numbers the turn within its own conversation', () => {
    const result = evaluateTrajectory([
      [TURN_MATCH],
      [TURN_MATCH, TURN_MATCH, TURN_MISMATCH_INPUT],
    ]);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].conversationIndex).toBe(1);
    expect(result.failures[0].turn).toBe(3);
  });

  it('reports no failure when every turn matches', () => {
    expect(evaluateTrajectory([[TURN_MATCH]]).failures).toEqual([]);
  });

  it('carries the query and response onto each turn result', () => {
    const [turnResult] = evaluateTrajectory([[TURN_MATCH]]).turnResults;

    expect(turnResult.query).toBe('Q1');
    expect(turnResult.response).toBe('R1');
    expect(turnResult.toolUseAccuracy).toBe(1);
  });

  it('strips mockToolOutput from the result without mutating the input', () => {
    const expectedCall: ToolUse = {
      toolName: 'getWeather',
      toolInput: {location: 'SF'},
      mockToolOutput: 'Sunny',
    };
    const turn: EvalTurn = {
      query: 'Q',
      response: 'R',
      actualToolUse: [TOOL_GET_WEATHER_SF],
      expectedToolUse: [expectedCall],
    };

    const result = evaluateTrajectory([[turn]]);

    expect(result.turnResults[0].expectedToolUse[0]).not.toHaveProperty(
      'mockToolOutput',
    );
    expect(expectedCall.mockToolOutput).toBe('Sunny');
    expect(turn.expectedToolUse[0]).toHaveProperty('mockToolOutput');
  });

  it('passes the actual calls through unchanged', () => {
    const result = evaluateTrajectory([[TURN_MATCH]]);

    expect(result.turnResults[0].actualToolUse).toEqual([TOOL_ROLL_DICE_16]);
  });
});

describe('areToolsEqual', () => {
  it('matches identical trajectories', () => {
    expect(
      areToolsEqual(
        [TOOL_GET_WEATHER, TOOL_ROLL_DICE_6],
        [TOOL_GET_WEATHER, TOOL_ROLL_DICE_6],
      ),
    ).toBe(true);
  });

  it('matches two empty trajectories', () => {
    expect(areToolsEqual([], [])).toBe(true);
  });

  it('rejects the same calls in a different order', () => {
    expect(
      areToolsEqual(
        [TOOL_ROLL_DICE_6, TOOL_GET_WEATHER],
        [TOOL_GET_WEATHER, TOOL_ROLL_DICE_6],
      ),
    ).toBe(false);
  });

  it('rejects trajectories of different lengths', () => {
    expect(
      areToolsEqual([TOOL_GET_WEATHER, TOOL_ROLL_DICE_6], [TOOL_GET_WEATHER]),
    ).toBe(false);
  });

  it('rejects a different tool input', () => {
    expect(areToolsEqual([TOOL_ROLL_DICE_16], [TOOL_ROLL_DICE_6])).toBe(false);
  });

  it('rejects a different tool name', () => {
    expect(areToolsEqual([TOOL_ROLL_DICE_16], [TOOL_GET_WEATHER])).toBe(false);
  });

  it('ignores properties other than toolName and toolInput', () => {
    expect(
      areToolsEqual([TOOL_GET_WEATHER_ANNOTATED], [TOOL_GET_WEATHER]),
    ).toBe(true);
    expect(
      areToolsEqual(
        [{...TOOL_GET_WEATHER, mockToolOutput: 'Sunny'}],
        [{...TOOL_GET_WEATHER, mockToolOutput: 'Raining'}],
      ),
    ).toBe(true);
  });

  it('rejects an empty trajectory against a non-empty one', () => {
    expect(areToolsEqual([], [TOOL_GET_WEATHER])).toBe(false);
    expect(areToolsEqual([TOOL_GET_WEATHER], [])).toBe(false);
  });

  it('ignores the key order of a tool input', () => {
    expect(
      areToolsEqual(
        [{toolName: 'search', toolInput: {a: 1, b: 2}}],
        [{toolName: 'search', toolInput: {b: 2, a: 1}}],
      ),
    ).toBe(true);
  });

  it('compares a nested tool input deeply', () => {
    expect(
      areToolsEqual(
        [{toolName: 'search', toolInput: {filter: {tags: ['a', 'b']}}}],
        [{toolName: 'search', toolInput: {filter: {tags: ['a', 'b']}}}],
      ),
    ).toBe(true);
    expect(
      areToolsEqual(
        [{toolName: 'search', toolInput: {filter: {tags: ['a', 'b']}}}],
        [{toolName: 'search', toolInput: {filter: {tags: ['b', 'a']}}}],
      ),
    ).toBe(false);
  });
});
