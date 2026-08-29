/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {deepEqual} from '../utils/deep_equal.js';
import {getLogger} from '../utils/logger.js';

const logger = getLogger();

/** A single tool call in a trajectory. */
export interface ToolUse {
  /** Name of the tool that was called. */
  toolName: string;

  /** Arguments the tool was called with. */
  toolInput: Record<string, unknown>;

  /**
   * Output recorded for an expected call so a replay can serve it. Ignored
   * when scoring.
   */
  mockToolOutput?: unknown;
}

/** One turn of a conversation to be scored. */
export interface EvalTurn {
  /** What the user asked. */
  query: string;

  /** What the agent answered. */
  response: string;

  /** Tool calls the agent actually made, in order. */
  actualToolUse: ToolUse[];

  /** Tool calls the golden trajectory expected, in order. */
  expectedToolUse: ToolUse[];
}

/** Score for a single turn. */
export interface TurnEvaluationResult {
  query: string;
  response: string;
  actualToolUse: ToolUse[];

  /** Expected calls with `mockToolOutput` stripped. */
  expectedToolUse: ToolUse[];

  /** `1` when the trajectories matched, `0` otherwise. */
  toolUseAccuracy: number;
}

/** A turn whose trajectories did not match. */
export interface TrajectoryFailure {
  /** Zero-based index of the conversation within the dataset. */
  conversationIndex: number;

  /** One-based index of the turn within its conversation. */
  turn: number;

  query: string;
  actual: ToolUse[];
  expected: ToolUse[];
}

/** Outcome of scoring a whole eval dataset. */
export interface TrajectoryEvaluationResult {
  /**
   * Mean tool-use accuracy across every scored turn, in `[0, 1]`. `NaN` when
   * the dataset contained no turns at all.
   */
  meanToolUseAccuracy: number;

  /** One entry per scored turn, in dataset order. */
  turnResults: TurnEvaluationResult[];

  /** The subset of turns that did not match. */
  failures: TrajectoryFailure[];
}

/** A tool call reduced to the fields that take part in scoring. */
interface ComparableToolUse {
  toolName: string;
  toolInput: Record<string, unknown>;
}

/**
 * Whether two tool-call trajectories match.
 *
 * The comparison is order-sensitive and length-sensitive, and reads only
 * `toolName` and `toolInput`. Every other property, `mockToolOutput` included,
 * is ignored on both sides. `toolInput` is compared deeply, so key order does
 * not matter.
 */
export function areToolsEqual(a: ToolUse[], b: ToolUse[]): boolean {
  return deepEqual(toComparable(a), toComparable(b));
}

function toComparable(toolUses: ToolUse[]): ComparableToolUse[] {
  return toolUses.map(({toolName, toolInput}) => ({toolName, toolInput}));
}

/**
 * Copies the calls without `mockToolOutput`, leaving the input untouched.
 *
 * Any other property a caller attached survives the copy, so the recorded
 * output is the only thing dropped.
 */
function stripMockToolOutput(toolUses: ToolUse[]): ToolUse[] {
  return toolUses.map((toolUse) => {
    const copy = {...toolUse};
    delete copy.mockToolOutput;
    return copy;
  });
}

function evaluateTurn(turn: EvalTurn): TurnEvaluationResult {
  const expectedToolUse = stripMockToolOutput(turn.expectedToolUse);

  return {
    query: turn.query,
    response: turn.response,
    actualToolUse: turn.actualToolUse,
    expectedToolUse,
    toolUseAccuracy: areToolsEqual(turn.actualToolUse, expectedToolUse) ? 1 : 0,
  };
}

function reportFailures(failures: TrajectoryFailure[]): void {
  for (const failure of failures) {
    logger.debug(
      `Trajectory mismatch in conversation ${failure.conversationIndex}, ` +
        `turn ${failure.turn}, query '${failure.query}'. Actual: ` +
        `${JSON.stringify(failure.actual)}. Expected: ` +
        `${JSON.stringify(failure.expected)}.`,
    );
  }
}

/**
 * Scores an agent's tool use against a recorded golden trajectory.
 *
 * A turn scores `1` when its tool calls match the expected ones exactly, and
 * `0` otherwise. `meanToolUseAccuracy` averages those scores over every turn of
 * every conversation, so a conversation with more turns weighs more.
 *
 * @param evalDataset One entry per conversation, each a list of scored turns.
 *   An empty conversation contributes no turn. The parameter admits nullish
 *   input so a plain JavaScript caller gets the validation error below rather
 *   than a `TypeError`.
 * @throws {InputValidationError} When the dataset holds no conversation.
 *   `[[]]` does not throw: it holds one conversation, and the mean over its
 *   zero turns is `NaN`.
 */
export function evaluateTrajectory(
  evalDataset: EvalTurn[][] | null | undefined,
): TrajectoryEvaluationResult {
  if (!evalDataset?.length) {
    throw new InputValidationError('The evaluation dataset is empty.');
  }

  const turnResults: TurnEvaluationResult[] = [];
  const failures: TrajectoryFailure[] = [];

  for (const [conversationIndex, conversation] of evalDataset.entries()) {
    for (const [turnIndex, turn] of conversation.entries()) {
      const turnResult = evaluateTurn(turn);
      turnResults.push(turnResult);

      if (turnResult.toolUseAccuracy === 0) {
        failures.push({
          conversationIndex,
          turn: turnIndex + 1,
          query: turnResult.query,
          actual: turnResult.actualToolUse,
          expected: turnResult.expectedToolUse,
        });
      }
    }
  }

  reportFailures(failures);

  const total = turnResults.reduce(
    (sum, result) => sum + result.toolUseAccuracy,
    0,
  );

  return {
    meanToolUseAccuracy: total / turnResults.length,
    turnResults,
    failures,
  };
}
