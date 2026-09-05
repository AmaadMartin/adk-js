/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/evaluation/test_rubric_based_multi_turn_trajectory_evaluator.py`.
 * Each `it()` keeps the Python test name, so the two suites stay greppable
 * against each other.
 */

import {
  AppDetails,
  EvalMetric,
  EvalStatus,
  Invocation,
  InvocationEvents,
  PrebuiltMetrics,
  Rubric,
  RubricBasedMultiTurnTrajectoryEvaluator,
  assembleDialogueHistory,
} from '@google/adk';
import {Tool} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {FakeJudgeLlm} from './fake_judge_llm.js';

const RUBRICS: Rubric[] = [
  {
    rubricId: '1',
    rubricContent: {textProperty: 'The agent uses the correct tool.'},
    type: 'TOOL_USAGE',
  },
  {
    rubricId: '2',
    rubricContent: {textProperty: 'The agent fulfills the user intent.'},
    type: 'FULFILL_USER_INTENT',
  },
];

function createEvaluator(judge: FakeJudgeLlm): {
  evaluator: RubricBasedMultiTurnTrajectoryEvaluator;
  judge: FakeJudgeLlm;
} {
  const evalMetric: EvalMetric = {
    metricName: PrebuiltMetrics.RUBRIC_BASED_MULTI_TURN_TRAJECTORY_QUALITY_V1,
    threshold: 0.5,
    criterion: {
      threshold: 0.5,
      rubrics: RUBRICS,
      judgeModelOptions: {numSamples: 3},
    },
  };
  return {
    evaluator: new RubricBasedMultiTurnTrajectoryEvaluator(evalMetric, judge),
    judge,
  };
}

function createInvocation(options: {
  userText: string;
  agentText?: string;
  invocationId?: string;
  rubrics?: Rubric[];
  appDetails?: AppDetails;
  intermediateData?: InvocationEvents;
}): Invocation {
  return {
    invocationId: options.invocationId ?? '',
    userContent: {parts: [{text: options.userText}]},
    finalResponse: options.agentText
      ? {parts: [{text: options.agentText}]}
      : undefined,
    rubrics: options.rubrics,
    appDetails: options.appDetails,
    intermediateData: options.intermediateData,
  };
}

/** The prompt the metric sent the judge on its first call. */
function firstPrompt(judge: FakeJudgeLlm): string {
  return judge.requests[0]?.contents?.[0]?.parts?.[0]?.text ?? '';
}

describe('format_auto_rater_prompt', () => {
  it('test_basic_dialogue_and_rubrics_in_prompt', async () => {
    const {evaluator, judge} = createEvaluator(
      new FakeJudgeLlm([{silent: true}]),
    );
    const invocation = createInvocation({
      userText: 'What is the balance?',
      agentText: 'Your balance is $100.',
      rubrics: RUBRICS,
    });

    await evaluator.evaluateInvocations([invocation]);

    const prompt = firstPrompt(judge);
    expect(prompt).toContain('USER TURN 1: What is the balance?');
    expect(prompt).toContain('The agent uses the correct tool.');
    expect(prompt).toContain('The agent fulfills the user intent.');
    expect(prompt).toContain('TOOL_USAGE');
    expect(prompt).toContain('FULFILL_USER_INTENT');
  });

  it('test_prompt_includes_agent_instructions_and_tools', async () => {
    const {evaluator, judge} = createEvaluator(
      new FakeJudgeLlm([{silent: true}]),
    );
    const tool: Tool = {
      functionDeclarations: [
        {
          name: 'transfer_funds',
          description: 'Transfer money between accounts.',
        },
      ],
    };
    const invocation = createInvocation({
      userText: 'Transfer funds',
      rubrics: RUBRICS,
      appDetails: {
        agentDetails: {
          banking_agent: {
            name: 'banking_agent',
            instructions: 'You are a banking assistant.',
            toolDeclarations: [tool],
          },
        },
      },
    });

    await evaluator.evaluateInvocations([invocation]);

    const prompt = firstPrompt(judge);
    expect(prompt).toContain('You are a banking assistant.');
    expect(prompt).toContain('transfer_funds');
  });
});

describe('dialogue assembly', () => {
  it('test_empty_conversation_returns_not_evaluated', async () => {
    const {evaluator} = createEvaluator(new FakeJudgeLlm([{silent: true}]));

    const result = await evaluator.evaluateInvocations([]);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
  });

  it('test_single_turn_user_and_agent', () => {
    const invocations = [
      createInvocation({
        userText: 'Hello',
        agentText: 'Hi there!',
        invocationId: 'agent1',
        rubrics: RUBRICS,
      }),
    ];

    const {dialogue} = assembleDialogueHistory(invocations);

    expect(dialogue).toContain('USER TURN 1: Hello');
    expect(dialogue).toContain('AGENT (agent) TURN 1: Hi there!');
  });

  it('test_multi_turn_dialogue', () => {
    const invocations = [
      createInvocation({
        userText: 'Check my balance',
        agentText: 'Your balance is $100.',
        invocationId: 'agent1',
        rubrics: RUBRICS,
      }),
      createInvocation({
        userText: 'Transfer $50',
        agentText: 'Transfer complete.',
        invocationId: 'agent1',
        rubrics: RUBRICS,
      }),
    ];

    const {dialogue} = assembleDialogueHistory(invocations);

    expect(dialogue).toContain('USER TURN 1: Check my balance');
    expect(dialogue).toContain('AGENT (agent) TURN 1: Your balance is $100.');
    expect(dialogue).toContain('USER TURN 2: Transfer $50');
    expect(dialogue).toContain('AGENT (agent) TURN 2: Transfer complete.');
  });

  it('test_intermediate_events_with_function_calls', () => {
    const intermediateData: InvocationEvents = {
      invocationEvents: [
        {
          author: 'banking_agent',
          content: {
            parts: [
              {functionCall: {name: 'get_balance', args: {account_id: '123'}}},
            ],
          },
        },
        {
          author: 'banking_agent',
          content: {
            parts: [
              {
                functionResponse: {
                  name: 'get_balance',
                  response: {balance: 100},
                },
              },
            ],
          },
        },
      ],
    };
    const invocations = [
      createInvocation({
        userText: 'What is my balance?',
        agentText: 'Your balance is $100.',
        invocationId: 'banking_agent',
        rubrics: RUBRICS,
        intermediateData,
      }),
    ];

    const {dialogue} = assembleDialogueHistory(invocations);

    expect(dialogue).toContain('get_balance');
    expect(dialogue).toContain('"account_id": "123"');
    expect(dialogue).toContain('"balance": 100');
  });

  it('test_app_details_instructions_and_tools', () => {
    const tool: Tool = {
      functionDeclarations: [
        {
          name: 'transfer_funds',
          description: 'Transfer money between accounts.',
        },
      ],
    };
    const invocations = [
      createInvocation({
        userText: 'Transfer $50',
        agentText: 'Done.',
        invocationId: 'banking_agent',
        rubrics: RUBRICS,
        appDetails: {
          agentDetails: {
            banking_agent: {
              name: 'banking_agent',
              instructions: 'You are a banking assistant.',
              toolDeclarations: [tool],
            },
          },
        },
      }),
    ];

    const {instructions, tools} = assembleDialogueHistory(invocations);

    expect(instructions).toContain('You are a banking assistant.');
    expect(tools).toContain('transfer_funds');
    expect(tools).toContain('Transfer money between accounts.');
  });

  it('test_invocation_without_user_content', () => {
    const invocations: Invocation[] = [
      {
        invocationId: 'agent1',
        userContent: {parts: []},
        finalResponse: {parts: [{text: 'Agent response.'}]},
        rubrics: RUBRICS,
      },
    ];

    const {dialogue} = assembleDialogueHistory(invocations);

    expect(dialogue).not.toContain('USER TURN');
    expect(dialogue).toContain('AGENT (agent) TURN 1: Agent response.');
  });
});
