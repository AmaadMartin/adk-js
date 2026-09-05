/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The metric driven end to end against a scripted judge: one prompt carries
 * the whole conversation, the earlier turns report `NOT_EVALUATED`, and the
 * last turn carries the score.
 */

import {
  EvalMetric,
  EvalStatus,
  InputValidationError,
  Invocation,
  PrebuiltMetrics,
  Rubric,
  RubricBasedMultiTurnTrajectoryEvaluator,
  RubricScore,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {FakeJudgeLlm, JudgeReply} from './fake_judge_llm.js';

const RUBRICS: Rubric[] = [
  {
    rubricId: '1',
    rubricContent: {textProperty: 'Did the agent search for flights?'},
  },
  {
    rubricId: '2',
    rubricContent: {textProperty: 'Did the agent confirm before booking?'},
  },
];

function createEvaluator(
  options: {
    judge?: FakeJudgeLlm;
    numSamples?: number;
  } = {},
): RubricBasedMultiTurnTrajectoryEvaluator {
  const evalMetric: EvalMetric = {
    metricName: PrebuiltMetrics.RUBRIC_BASED_MULTI_TURN_TRAJECTORY_QUALITY_V1,
    criterion: {
      threshold: 0.5,
      rubrics: RUBRICS,
      judgeModelOptions: {numSamples: options.numSamples ?? 1},
    },
  };
  return new RubricBasedMultiTurnTrajectoryEvaluator(
    evalMetric,
    options.judge ?? new FakeJudgeLlm([{silent: true}]),
  );
}

function createInvocation(
  userText: string,
  agentText: string,
  rubrics?: Rubric[],
): Invocation {
  return {
    userContent: {parts: [{text: userText}]},
    finalResponse: {parts: [{text: agentText}]},
    rubrics,
  };
}

/** A three-turn booking conversation. */
function createConversation(lastTurnRubrics?: Rubric[]): Invocation[] {
  return [
    createInvocation('Find me a flight to Tokyo.', 'I found three flights.'),
    createInvocation('Book the first one.', 'Please confirm the $800 fare.'),
    createInvocation(
      'Confirmed.',
      'Booked, your code is ABC123.',
      lastTurnRubrics,
    ),
  ];
}

/** A judge answer that scores both criterion rubrics with the given verdicts. */
function critique(first: string, second: string): JudgeReply {
  return {
    critique:
      'ID: 1\nProperty: Did the agent search for flights?\n' +
      `Rationale: Because.\nVerdict: ${first}\n\n` +
      'ID: 2\nProperty: Did the agent confirm before booking?\n' +
      `Rationale: Because.\nVerdict: ${second}\n`,
  };
}

/** The prompts the metric sent the judge, in call order. */
function prompts(judge: FakeJudgeLlm): string[] {
  return judge.requests.map(
    (request) => request.contents?.[0]?.parts?.[0]?.text ?? '',
  );
}

function scoresById(
  rubricScores: RubricScore[] | undefined,
): Record<string, number | undefined> {
  return Object.fromEntries(
    (rubricScores ?? []).map((rubricScore) => [
      rubricScore.rubricId,
      rubricScore.score,
    ]),
  );
}

describe('evaluateInvocations over a whole conversation', () => {
  it('scores only the last turn and reports the rest NOT_EVALUATED', async () => {
    const judge = new FakeJudgeLlm([critique('yes', 'no')]);
    const conversation = createConversation();

    const result = await createEvaluator({judge}).evaluateInvocations(
      conversation,
    );

    expect(result.perInvocationResults).toHaveLength(3);
    for (const index of [0, 1]) {
      expect(result.perInvocationResults[index].actualInvocation).toBe(
        conversation[index],
      );
      expect(result.perInvocationResults[index].score).toBeUndefined();
      expect(result.perInvocationResults[index].evalStatus).toBe(
        EvalStatus.NOT_EVALUATED,
      );
    }

    const last = result.perInvocationResults[2];
    expect(last.actualInvocation).toBe(conversation[2]);
    expect(last.score).toBe(0.5);
    expect(scoresById(last.rubricScores)).toEqual({'1': 1.0, '2': 0.0});
    expect(result.overallScore).toBe(0.5);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
    expect(scoresById(result.overallRubricScores)).toEqual({
      '1': 1.0,
      '2': 0.0,
    });
  });

  it('builds exactly one judge prompt, carrying every turn', async () => {
    const judge = new FakeJudgeLlm([critique('yes', 'yes')]);

    await createEvaluator({judge, numSamples: 3}).evaluateInvocations(
      createConversation(),
    );

    expect(judge.requests).toHaveLength(3);
    const distinctPrompts = new Set(prompts(judge));
    expect(distinctPrompts.size).toBe(1);
    const prompt = prompts(judge)[0];
    expect(prompt).toContain('USER TURN 1: Find me a flight to Tokyo.');
    expect(prompt).toContain(
      'AGENT (agent) TURN 2: Please confirm the $800 fare.',
    );
    expect(prompt).toContain('USER TURN 3: Confirmed.');
  });

  it('pairs every turn with its golden invocation', async () => {
    const judge = new FakeJudgeLlm([critique('yes', 'yes')]);
    const conversation = createConversation();
    const golden = createConversation();

    const result = await createEvaluator({judge}).evaluateInvocations(
      conversation,
      golden,
    );

    expect(
      result.perInvocationResults.map((entry) => entry.expectedInvocation),
    ).toEqual(golden);
  });

  it('rejects a golden conversation of a different length', async () => {
    const evaluator = createEvaluator();

    await expect(
      evaluator.evaluateInvocations(createConversation(), [
        createInvocation('Confirmed.', 'Booked.'),
      ]),
    ).rejects.toThrow(InputValidationError);
  });

  it('still reports the last turn when the judge produced no result', async () => {
    const conversation = createConversation();
    const golden = createConversation();

    const result = await createEvaluator({
      numSamples: 0,
    }).evaluateInvocations(conversation, golden);

    expect(result.perInvocationResults).toHaveLength(3);
    const last = result.perInvocationResults[2];
    expect(last.actualInvocation).toBe(conversation[2]);
    expect(last.expectedInvocation).toBe(golden[2]);
    expect(last.score).toBeUndefined();
    expect(last.evalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.overallScore).toBeUndefined();
  });
});

describe('the rubrics the prompt lists', () => {
  it('grades the TRAJECTORY_QUALITY rubrics of the last invocation', async () => {
    expect(RubricBasedMultiTurnTrajectoryEvaluator.RUBRIC_TYPE).toBe(
      'TRAJECTORY_QUALITY',
    );
    const judge = new FakeJudgeLlm([{silent: true}]);
    const conversation = createConversation([
      {
        rubricId: '3',
        rubricContent: {textProperty: 'Did the agent quote a fare?'},
        type: 'TRAJECTORY_QUALITY',
      },
      {
        rubricId: '4',
        rubricContent: {textProperty: 'Did the agent call one tool only?'},
        type: 'TOOL_USE_QUALITY',
      },
    ]);

    await createEvaluator({judge}).evaluateInvocations(conversation);

    const prompt = prompts(judge)[0];
    expect(prompt).toContain('Did the agent quote a fare?');
    expect(prompt).not.toContain('Did the agent call one tool only?');
  });

  it('lists a rubric type only when the rubric sets one', async () => {
    const judge = new FakeJudgeLlm([{silent: true}]);
    const conversation = createConversation([
      {
        rubricId: '3',
        rubricContent: {textProperty: 'Did the agent quote a fare?'},
        type: 'TRAJECTORY_QUALITY',
      },
    ]);

    await createEvaluator({judge}).evaluateInvocations(conversation);

    const prompt = prompts(judge)[0];
    expect(prompt).toContain('"id": "1"');
    expect(prompt.match(/"type":/g)).toHaveLength(1);
    expect(prompt).toContain('"type": "TRAJECTORY_QUALITY"');
  });

  it('renders an empty transcript before any conversation is graded', () => {
    const prompt = createEvaluator().formatAutoRaterPrompt(
      createInvocation('Confirmed.', 'Booked.'),
    );

    expect(prompt).toContain(
      '<conversation_history>\n\n</conversation_history>',
    );
    expect(prompt).toContain(
      '<agent_system_instructions>\n\n</agent_system_instructions>',
    );
  });
});
