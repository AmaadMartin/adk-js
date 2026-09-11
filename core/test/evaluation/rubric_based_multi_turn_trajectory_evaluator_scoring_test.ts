/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scoring and dialogue tests for
 * {@link RubricBasedMultiTurnTrajectoryEvaluator} that adk-python's suite does
 * not cover. The ported reference tests live in
 * `rubric_based_multi_turn_trajectory_evaluator_test.ts`.
 */

import {
  EvalMetric,
  EvalStatus,
  InputValidationError,
  Invocation,
  InvocationEvents,
  PrebuiltMetrics,
  Rubric,
  RubricBasedMultiTurnTrajectoryEvaluator,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {FakeJudgeLlm, JudgeReply} from './fake_judge_llm.js';

const NUM_SAMPLES = 3;

const RUBRICS: Rubric[] = [
  {
    rubricId: '1',
    rubricContent: {textProperty: 'The agent uses the correct tool.'},
  },
  {
    rubricId: '2',
    rubricContent: {textProperty: 'The agent fulfills the user intent.'},
  },
];

/** A judge answer that scores both rubrics `yes`. */
const BOTH_RUBRICS_PASS: JudgeReply = {
  critique: [
    'ID: 1',
    'Property: The agent uses the correct tool.',
    'Rationale: It called the tool the user asked for.',
    'Verdict: yes',
    'ID: 2',
    'Property: The agent fulfills the user intent.',
    'Rationale: It answered the question.',
    'Verdict: yes',
  ].join('\n'),
};

interface EvaluatorOptions {
  rubrics?: Rubric[];
  replies?: JudgeReply[];
  numSamples?: number;
}

function createEvaluator(options: EvaluatorOptions = {}): {
  evaluator: RubricBasedMultiTurnTrajectoryEvaluator;
  judge: FakeJudgeLlm;
} {
  const evalMetric: EvalMetric = {
    metricName: PrebuiltMetrics.RUBRIC_BASED_MULTI_TURN_TRAJECTORY_QUALITY_V1,
    threshold: 0.5,
    criterion: {
      threshold: 0.5,
      rubrics: options.rubrics ?? RUBRICS,
      judgeModelOptions: {numSamples: options.numSamples ?? NUM_SAMPLES},
    },
  };
  const judge = new FakeJudgeLlm(options.replies ?? [BOTH_RUBRICS_PASS]);
  return {
    evaluator: new RubricBasedMultiTurnTrajectoryEvaluator(evalMetric, judge),
    judge,
  };
}

function createInvocation(userText: string, agentText: string): Invocation {
  return {
    userContent: {parts: [{text: userText}]},
    finalResponse: {parts: [{text: agentText}]},
  };
}

const THREE_TURNS: Invocation[] = [
  createInvocation('Check my balance', 'Your balance is $100.'),
  createInvocation('Transfer $50', 'To which account?'),
  createInvocation('The savings account', 'Transfer complete.'),
];

/** Returns the prompt the metric sent to the judge on its first call. */
function sentPrompt(judge: FakeJudgeLlm): string {
  const text = judge.requests[0]?.contents[0]?.parts?.[0]?.text;
  if (text === undefined) {
    expect.fail('The metric sent no prompt to the judge.');
  }
  return text;
}

/** Returns how many times the needle occurs in the text. */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('RubricBasedMultiTurnTrajectoryEvaluator scoring', () => {
  it('marks the first turns not evaluated and scores the last', async () => {
    const {evaluator} = createEvaluator();

    const result = await evaluator.evaluateInvocations(THREE_TURNS);

    expect(result.perInvocationResults).toHaveLength(3);
    expect(result.perInvocationResults[0].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.perInvocationResults[0].score).toBeUndefined();
    expect(result.perInvocationResults[1].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.perInvocationResults[1].score).toBeUndefined();
    expect(result.perInvocationResults[2].evalStatus).toBe(EvalStatus.PASSED);
    expect(result.perInvocationResults[2].score).toBe(1.0);
    expect(result.perInvocationResults[2].actualInvocation).toBe(
      THREE_TURNS[2],
    );
    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('runs the judge once for the whole conversation', async () => {
    const {evaluator, judge} = createEvaluator();

    await evaluator.evaluateInvocations(THREE_TURNS);

    expect(judge.requests).toHaveLength(NUM_SAMPLES);
    const prompt = sentPrompt(judge);
    expect(prompt).toContain('USER TURN 1: Check my balance');
    expect(prompt).toContain('USER TURN 3: The savings account');
  });

  it('propagates the rubric scores of the delegated last turn', async () => {
    const {evaluator} = createEvaluator();

    const result = await evaluator.evaluateInvocations(THREE_TURNS);

    expect(result.overallRubricScores).toEqual([
      expect.objectContaining({rubricId: '1', score: 1.0}),
      expect.objectContaining({rubricId: '2', score: 1.0}),
    ]);
    expect(result.perInvocationResults[2].rubricScores).toEqual([
      {
        rubricId: '1',
        rationale: 'It called the tool the user asked for.',
        score: 1.0,
      },
      {rubricId: '2', rationale: 'It answered the question.', score: 1.0},
    ]);
  });

  it('rejects actual and expected lists of different lengths', async () => {
    const {evaluator, judge} = createEvaluator();

    await expect(
      evaluator.evaluateInvocations(THREE_TURNS, [THREE_TURNS[0]]),
    ).rejects.toThrow(InputValidationError);
    expect(judge.requests).toHaveLength(0);
  });

  it('pairs each expected invocation with its actual one', async () => {
    const {evaluator} = createEvaluator();
    const expected: Invocation[] = [
      createInvocation('Check my balance', 'Balance: $100.'),
      createInvocation('Transfer $50', 'Which account?'),
      createInvocation('The savings account', 'Done.'),
    ];

    const result = await evaluator.evaluateInvocations(THREE_TURNS, expected);

    expect(result.perInvocationResults[0].expectedInvocation).toBe(expected[0]);
    expect(result.perInvocationResults[1].expectedInvocation).toBe(expected[1]);
    expect(result.perInvocationResults[2].expectedInvocation).toBe(expected[2]);
  });

  it('rejects a conversation that carries no rubric at all', async () => {
    const {evaluator} = createEvaluator({rubrics: []});

    await expect(
      evaluator.evaluateInvocations([createInvocation('Hello', 'Hi.')]),
    ).rejects.toThrow(new InputValidationError('Rubrics are required.'));
  });

  it('grades only the invocation rubrics typed TRAJECTORY_QUALITY', async () => {
    const {evaluator, judge} = createEvaluator({rubrics: []});
    const invocation: Invocation = {
      ...createInvocation('Book a flight', 'Booked.'),
      rubrics: [
        {
          rubricId: 'kept',
          rubricContent: {textProperty: 'The agent booked the flight.'},
          type: RubricBasedMultiTurnTrajectoryEvaluator.RUBRIC_TYPE,
        },
        {
          rubricId: 'dropped',
          rubricContent: {textProperty: 'The agent called one tool.'},
          type: 'TOOL_USE_QUALITY',
        },
      ],
    };

    await evaluator.evaluateInvocations([invocation]);

    const prompt = sentPrompt(judge);
    expect(prompt).toContain('The agent booked the flight.');
    expect(prompt).not.toContain('The agent called one tool.');
  });

  it('renders an empty object for a tool call and response with no payload', async () => {
    const {evaluator, judge} = createEvaluator();
    const intermediateData: InvocationEvents = {
      invocationEvents: [
        {
          author: 'ping_agent',
          content: {
            parts: [
              {functionCall: {name: 'ping'}},
              {functionResponse: {name: 'ping'}},
            ],
          },
        },
      ],
    };

    await evaluator.evaluateInvocations([
      {...createInvocation('Ping the service', 'Pong.'), intermediateData},
    ]);

    const prompt = sentPrompt(judge);
    expect(prompt).toContain('AGENT (ping_agent) TURN 1 (tool call): ping({})');
    expect(prompt).toContain(
      'AGENT (ping_agent) TURN 1 (tool output): ping -> {}',
    );
  });

  it('names an event authored by the user as a user turn', async () => {
    const {evaluator, judge} = createEvaluator();
    const intermediateData: InvocationEvents = {
      invocationEvents: [
        {author: 'User', content: {parts: [{text: 'Actually, make it two.'}]}},
        {author: 'booking_agent', content: {parts: [{text: 'Two it is.'}]}},
      ],
    };

    await evaluator.evaluateInvocations([
      {
        ...createInvocation('Book a flight', 'Booked two seats.'),
        intermediateData,
      },
    ]);

    const prompt = sentPrompt(judge);
    expect(prompt).toContain('USER TURN 1: Actually, make it two.');
    expect(prompt).toContain('AGENT (booking_agent) TURN 1: Two it is.');
    // The final response is attributed to the first event's author, which is
    // the user event here.
    expect(prompt).toContain('AGENT (User) TURN 1: Booked two seats.');
  });

  it('lists an agent repeated across turns once', async () => {
    const {evaluator, judge} = createEvaluator();
    const appDetails = {
      agentDetails: {
        banking_agent: {
          name: 'banking_agent',
          instructions: 'You are a banking assistant.',
          toolDeclarations: [
            {
              functionDeclarations: [
                {name: 'transfer_funds', description: 'Move money.'},
              ],
            },
          ],
        },
      },
    };

    await evaluator.evaluateInvocations([
      {...createInvocation('Check my balance', '$100.'), appDetails},
      {...createInvocation('Transfer $50', 'Done.'), appDetails},
    ]);

    const prompt = sentPrompt(judge);
    expect(countOf(prompt, 'Agent banking_agent Instructions:')).toBe(1);
    expect(countOf(prompt, 'Agent: banking_agent')).toBe(1);
    expect(countOf(prompt, '- transfer_funds: Move money.')).toBe(1);
  });

  it('collects the agents of every turn, not just the first', async () => {
    const {evaluator, judge} = createEvaluator();

    await evaluator.evaluateInvocations([
      {
        ...createInvocation('Check my balance', '$100.'),
        appDetails: {
          agentDetails: {
            banking_agent: {
              name: 'banking_agent',
              instructions: 'You are a banking assistant.',
            },
          },
        },
      },
      {
        ...createInvocation('Book a flight', 'Booked.'),
        appDetails: {
          agentDetails: {
            booking_agent: {
              name: 'booking_agent',
              instructions: 'You are a booking assistant.',
            },
          },
        },
      },
    ]);

    const prompt = sentPrompt(judge);
    expect(prompt).toContain(
      'Agent banking_agent Instructions:\nYou are a banking assistant.',
    );
    expect(prompt).toContain(
      'Agent booking_agent Instructions:\nYou are a booking assistant.',
    );
    expect(prompt).toContain('Agent: banking_agent');
    expect(prompt).toContain('Agent: booking_agent');
  });

  it('joins the text parts of one turn with a single space', async () => {
    const {evaluator, judge} = createEvaluator();
    const intermediateData: InvocationEvents = {
      invocationEvents: [
        {
          author: 'booking_agent',
          content: {
            parts: [{text: 'Searching flights.'}, {text: 'One moment.'}],
          },
        },
      ],
    };

    await evaluator.evaluateInvocations([
      {
        userContent: {parts: [{text: 'Book a flight.'}, {text: 'To Rome.'}]},
        finalResponse: {parts: [{text: 'Booked.'}, {text: 'Seat 12A.'}]},
        intermediateData,
      },
    ]);

    const prompt = sentPrompt(judge);
    expect(prompt).toContain('USER TURN 1: Book a flight. To Rome.');
    expect(prompt).toContain(
      'AGENT (booking_agent) TURN 1: Searching flights. One moment.',
    );
    expect(prompt).toContain('AGENT (booking_agent) TURN 1: Booked. Seat 12A.');
  });

  it('skips an event that carries no content', async () => {
    const {evaluator, judge} = createEvaluator();
    const intermediateData: InvocationEvents = {
      invocationEvents: [
        {author: 'silent_agent'},
        {author: 'booking_agent', content: {parts: [{text: 'Working on it.'}]}},
      ],
    };

    await evaluator.evaluateInvocations([
      {...createInvocation('Book a flight', 'Booked.'), intermediateData},
    ]);

    // The silent event contributes no line of its own. It still names the
    // agent of the final response, as the first event of the invocation.
    expect(sentPrompt(judge)).toContain(
      '<conversation_history>\n' +
        'USER TURN 1: Book a flight\n' +
        'AGENT (booking_agent) TURN 1: Working on it.\n' +
        'AGENT (silent_agent) TURN 1: Booked.\n' +
        '</conversation_history>',
    );
  });

  it('renders an agent that declares no instructions, tools or description', async () => {
    const {evaluator, judge} = createEvaluator();

    await evaluator.evaluateInvocations([
      {
        ...createInvocation('Ping', 'Pong.'),
        appDetails: {
          agentDetails: {
            bare_agent: {name: 'bare_agent'},
            partial_agent: {
              name: 'partial_agent',
              toolDeclarations: [{}, {functionDeclarations: [{name: 'ping'}]}],
            },
          },
        },
      },
    ]);

    const prompt = sentPrompt(judge);
    expect(prompt).toContain('Agent bare_agent Instructions:\n\n');
    expect(prompt).toContain('Agent: bare_agent');
    expect(prompt).toContain('Agent: partial_agent\n- ping: ');
  });

  it('keeps an entry for the last turn when the judge produced no result', async () => {
    // `numSamples: 0` asks for no judge call, so the delegation returns no
    // per-invocation result. The last turn still needs its entry.
    const {evaluator, judge} = createEvaluator({numSamples: 0});

    const result = await evaluator.evaluateInvocations(THREE_TURNS);

    expect(judge.requests).toHaveLength(0);
    expect(result.perInvocationResults).toHaveLength(3);
    expect(result.perInvocationResults[2].actualInvocation).toBe(
      THREE_TURNS[2],
    );
    expect(result.perInvocationResults[2].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('marks the last turn not evaluated when every judge sample fails', async () => {
    const {evaluator} = createEvaluator({
      replies: [{failure: 'judge unavailable'}],
    });

    const result = await evaluator.evaluateInvocations(THREE_TURNS);

    expect(result.perInvocationResults).toHaveLength(3);
    expect(result.perInvocationResults[2].evalStatus).toBe(
      EvalStatus.NOT_EVALUATED,
    );
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
  });
});
