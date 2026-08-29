/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalTurn,
  evaluateResponses,
  InputValidationError,
  ResponseCriterion,
  ROUGE_1_METRIC,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const SAMPLE_TURN_1_ALL_KEYS: EvalTurn = {
  query: 'query1',
  response: 'response1',
  actual_tool_use: [{tool_name: 'tool_a', tool_input: {}}],
  expected_tool_use: [{tool_name: 'tool_a', tool_input: {}}],
  reference: 'reference1',
};

const SAMPLE_TURN_2_MISSING_REF: EvalTurn = {
  query: 'query2',
  response: 'response2',
  actual_tool_use: [],
  expected_tool_use: [],
};

const SAMPLE_TURN_3_MISSING_EXP_TOOLS: EvalTurn = {
  query: 'query3',
  response: 'response3',
  actual_tool_use: [{tool_name: 'tool_b', tool_input: {}}],
  reference: 'reference3',
};

const SAMPLE_TURN_4_MINIMAL: EvalTurn = {
  query: 'query4',
  response: 'response4',
};

const MATCHING_TURN: EvalTurn = {
  query: 'roll a die for me',
  response: 'I rolled a 16 sided die and got 13.',
  reference: 'I rolled a 16 sided die and got 13.',
};

describe('evaluateResponses', () => {
  it('rejects a null dataset', () => {
    expect(() =>
      evaluateResponses(null, [ResponseCriterion.RESPONSE_EVALUATION_SCORE]),
    ).toThrow(new InputValidationError('The evaluation dataset is empty.'));
  });

  it('rejects an empty dataset', () => {
    expect(() =>
      evaluateResponses([], [ResponseCriterion.RESPONSE_EVALUATION_SCORE]),
    ).toThrow(new InputValidationError('The evaluation dataset is empty.'));
  });

  it('scores response_match_score when the first turn has a reference', () => {
    const summary = evaluateResponses(
      [[MATCHING_TURN]],
      [ResponseCriterion.RESPONSE_MATCH_SCORE],
    );

    expect(summary).toEqual({
      rowCount: 1,
      summaryMetrics: {[ROUGE_1_METRIC]: 1},
      perTurnScores: {[ROUGE_1_METRIC]: [1]},
    });
  });

  it('rejects response_evaluation_score as unsupported', () => {
    expect(() =>
      evaluateResponses(
        [[SAMPLE_TURN_1_ALL_KEYS]],
        [ResponseCriterion.RESPONSE_EVALUATION_SCORE],
      ),
    ).toThrow(InputValidationError);
    expect(() =>
      evaluateResponses(
        [[SAMPLE_TURN_1_ALL_KEYS]],
        [ResponseCriterion.RESPONSE_EVALUATION_SCORE],
      ),
    ).toThrow(/Vertex AI evaluation service/);
  });

  it('skips response_evaluation_score when the first turn has no expected_tool_use', () => {
    const summary = evaluateResponses(
      [[SAMPLE_TURN_3_MISSING_EXP_TOOLS]],
      [ResponseCriterion.RESPONSE_EVALUATION_SCORE],
    );

    expect(summary).toEqual({
      rowCount: 1,
      summaryMetrics: {},
      perTurnScores: {},
    });
  });

  it('skips response_match_score when the first turn has no reference', () => {
    const summary = evaluateResponses(
      [[SAMPLE_TURN_2_MISSING_REF]],
      [ResponseCriterion.RESPONSE_MATCH_SCORE],
    );

    expect(summary).toEqual({
      rowCount: 1,
      summaryMetrics: {},
      perTurnScores: {},
    });
  });

  it('reads only the first turn when it picks metrics', () => {
    const summary = evaluateResponses(
      [[SAMPLE_TURN_4_MINIMAL, SAMPLE_TURN_1_ALL_KEYS]],
      [
        ResponseCriterion.RESPONSE_EVALUATION_SCORE,
        ResponseCriterion.RESPONSE_MATCH_SCORE,
      ],
    );

    expect(summary).toEqual({
      rowCount: 2,
      summaryMetrics: {},
      perTurnScores: {},
    });
  });

  it('scores nothing when the criteria list is empty', () => {
    const summary = evaluateResponses([[SAMPLE_TURN_1_ALL_KEYS]], []);

    expect(summary).toEqual({
      rowCount: 1,
      summaryMetrics: {},
      perTurnScores: {},
    });
  });

  it('ignores a criterion it does not know', () => {
    const summary = evaluateResponses(
      [[SAMPLE_TURN_1_ALL_KEYS]],
      ['tool_trajectory_avg_score'],
    );

    expect(summary).toEqual({
      rowCount: 1,
      summaryMetrics: {},
      perTurnScores: {},
    });
  });

  it('flattens every session into one score list', () => {
    const summary = evaluateResponses(
      [
        [MATCHING_TURN, {response: 'alpha beta', reference: 'alpha beta'}],
        [
          {response: 'gamma', reference: 'gamma delta'},
          {response: 'nothing alike', reference: 'wholly different'},
        ],
      ],
      [ResponseCriterion.RESPONSE_MATCH_SCORE],
    );

    expect(summary.rowCount).toBe(4);
    expect(summary.perTurnScores[ROUGE_1_METRIC]).toHaveLength(4);
    expect(summary.perTurnScores[ROUGE_1_METRIC][2]).toBeCloseTo(2 / 3);
    expect(summary.perTurnScores[ROUGE_1_METRIC][3]).toBe(0);
    expect(summary.summaryMetrics[ROUGE_1_METRIC]).toBeCloseTo(
      (1 + 1 + 2 / 3 + 0) / 4,
    );
  });

  it('reports no turn for a dataset whose only session is empty', () => {
    const summary = evaluateResponses(
      [[]],
      [ResponseCriterion.RESPONSE_MATCH_SCORE],
    );

    expect(summary).toEqual({
      rowCount: 0,
      summaryMetrics: {},
      perTurnScores: {},
    });
  });

  it('scores a turn without a reference 0 and keeps it in the mean', () => {
    const summary = evaluateResponses(
      [[MATCHING_TURN, {query: 'q', response: 'an unscored answer'}]],
      [ResponseCriterion.RESPONSE_MATCH_SCORE],
    );

    expect(summary.perTurnScores[ROUGE_1_METRIC]).toEqual([1, 0]);
    expect(summary.summaryMetrics[ROUGE_1_METRIC]).toBe(0.5);
  });

  it('scores a turn that produced no response 0', () => {
    const summary = evaluateResponses(
      [[MATCHING_TURN, {query: 'q', reference: 'an expected answer'}]],
      [ResponseCriterion.RESPONSE_MATCH_SCORE],
    );

    expect(summary.perTurnScores[ROUGE_1_METRIC]).toEqual([1, 0]);
  });

  it('does not modify the dataset it scores', () => {
    const dataset = [[MATCHING_TURN], [SAMPLE_TURN_1_ALL_KEYS]];
    const before = structuredClone(dataset);

    evaluateResponses(dataset, [ResponseCriterion.RESPONSE_MATCH_SCORE]);

    expect(dataset).toEqual(before);
  });
});
