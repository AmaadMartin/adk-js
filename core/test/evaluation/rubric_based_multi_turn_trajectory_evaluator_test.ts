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
 *
 * The Python suite reaches into `_formatted_dialogue` and friends. Reading a
 * private field is not allowed here, so each test drives
 * `evaluateInvocations` with a {@link FakeJudgeLlm} and asserts on the prompt
 * the metric actually sent. That also proves the transcript reached the
 * model, not merely that a field was set.
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
} from '@google/adk';
import {Content, Part, Tool} from '@google/genai';
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

function createEvalMetric(rubrics: Rubric[]): EvalMetric {
  return {
    metricName: PrebuiltMetrics.RUBRIC_BASED_MULTI_TURN_TRAJECTORY_QUALITY_V1,
    threshold: 0.5,
    criterion: {threshold: 0.5, rubrics, judgeModelOptions: {numSamples: 3}},
  };
}

/**
 * Returns an evaluator paired with the judge it grades through, so a test can
 * read the prompt the metric sent.
 */
function createEvaluator(rubrics: Rubric[] = RUBRICS): {
  evaluator: RubricBasedMultiTurnTrajectoryEvaluator;
  judge: FakeJudgeLlm;
} {
  const judge = new FakeJudgeLlm([{silent: true}]);
  return {
    evaluator: new RubricBasedMultiTurnTrajectoryEvaluator(
      createEvalMetric(rubrics),
      judge,
    ),
    judge,
  };
}

interface InvocationOptions {
  userText?: string;
  userParts?: Part[];
  agentText?: string;
  rubrics?: Rubric[];
  appDetails?: AppDetails;
  intermediateData?: InvocationEvents;
}

function createInvocation(options: InvocationOptions): Invocation {
  const userContent: Content = {
    parts: options.userParts ?? [{text: options.userText ?? ''}],
  };
  return {
    userContent,
    finalResponse:
      options.agentText === undefined
        ? undefined
        : {parts: [{text: options.agentText}]},
    rubrics: options.rubrics,
    appDetails: options.appDetails,
    intermediateData: options.intermediateData,
  };
}

/** Returns the prompt the metric sent to the judge on its first call. */
function sentPrompt(judge: FakeJudgeLlm): string {
  const text = judge.requests[0]?.contents[0]?.parts?.[0]?.text;
  if (text === undefined) {
    expect.fail('The metric sent no prompt to the judge.');
  }
  return text;
}

describe('RubricBasedMultiTurnTrajectoryEvaluator', () => {
  it('test_basic_dialogue_and_rubrics_in_prompt', async () => {
    const {evaluator, judge} = createEvaluator();

    await evaluator.evaluateInvocations([
      createInvocation({
        userText: 'What is the balance?',
        agentText: 'Your balance is $100.',
        rubrics: RUBRICS,
      }),
    ]);

    const prompt = sentPrompt(judge);
    expect(prompt).toContain('USER TURN 1: What is the balance?');
    expect(prompt).toContain('The agent uses the correct tool.');
    expect(prompt).toContain('The agent fulfills the user intent.');
    expect(prompt).toContain('TOOL_USAGE');
    expect(prompt).toContain('FULFILL_USER_INTENT');
  });

  it('test_prompt_includes_agent_instructions_and_tools', async () => {
    const {evaluator, judge} = createEvaluator();
    const tool: Tool = {
      functionDeclarations: [
        {
          name: 'transfer_funds',
          description: 'Transfer money between accounts.',
        },
      ],
    };

    await evaluator.evaluateInvocations([
      createInvocation({
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
      }),
    ]);

    const prompt = sentPrompt(judge);
    expect(prompt).toContain('You are a banking assistant.');
    expect(prompt).toContain('transfer_funds');
  });

  it('test_empty_conversation_returns_not_evaluated', async () => {
    const {evaluator, judge} = createEvaluator();

    const result = await evaluator.evaluateInvocations([]);

    expect(result.overallScore).toBeUndefined();
    expect(result.overallEvalStatus).toBe(EvalStatus.NOT_EVALUATED);
    expect(result.perInvocationResults).toEqual([]);
    expect(judge.requests).toHaveLength(0);
  });

  it('test_single_turn_user_and_agent', async () => {
    const {evaluator, judge} = createEvaluator();

    await evaluator.evaluateInvocations([
      createInvocation({
        userText: 'Hello',
        agentText: 'Hi there!',
        rubrics: RUBRICS,
      }),
    ]);

    const prompt = sentPrompt(judge);
    expect(prompt).toContain('USER TURN 1: Hello');
    expect(prompt).toContain('AGENT (agent) TURN 1: Hi there!');
  });

  it('test_multi_turn_dialogue', async () => {
    const {evaluator, judge} = createEvaluator();

    await evaluator.evaluateInvocations([
      createInvocation({
        userText: 'Check my balance',
        agentText: 'Your balance is $100.',
        rubrics: RUBRICS,
      }),
      createInvocation({
        userText: 'Transfer $50',
        agentText: 'Transfer complete.',
      }),
    ]);

    const prompt = sentPrompt(judge);
    expect(prompt).toContain('USER TURN 1: Check my balance');
    expect(prompt).toContain('AGENT (agent) TURN 1: Your balance is $100.');
    expect(prompt).toContain('USER TURN 2: Transfer $50');
    expect(prompt).toContain('AGENT (agent) TURN 2: Transfer complete.');
  });

  it('test_intermediate_events_with_function_calls', async () => {
    const {evaluator, judge} = createEvaluator();
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

    await evaluator.evaluateInvocations([
      createInvocation({
        userText: 'What is my balance?',
        agentText: 'Your balance is $100.',
        rubrics: RUBRICS,
        intermediateData,
      }),
    ]);

    const prompt = sentPrompt(judge);
    expect(prompt).toContain('get_balance');
    // The reference asserts `"account_id": "123"`. Python's `json.dumps` puts
    // a space after the colon and `JSON.stringify` does not, so this port
    // asserts the form it emits.
    expect(prompt).toContain('"account_id":"123"');
    expect(prompt).toContain('"balance":100');
    expect(prompt).toContain(
      'AGENT (banking_agent) TURN 1 (tool call):' +
        ' get_balance({"account_id":"123"})',
    );
    expect(prompt).toContain(
      'AGENT (banking_agent) TURN 1 (tool output):' +
        ' get_balance -> {"balance":100}',
    );
  });

  it('test_app_details_instructions_and_tools', async () => {
    const {evaluator, judge} = createEvaluator();
    const tool: Tool = {
      functionDeclarations: [
        {
          name: 'transfer_funds',
          description: 'Transfer money between accounts.',
        },
      ],
    };

    await evaluator.evaluateInvocations([
      createInvocation({
        userText: 'Transfer $50',
        agentText: 'Done.',
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
    ]);

    const prompt = sentPrompt(judge);
    expect(prompt).toContain(
      'Agent banking_agent Instructions:\nYou are a banking assistant.',
    );
    expect(prompt).toContain(
      'Agent: banking_agent\n- transfer_funds: Transfer money between' +
        ' accounts.',
    );
  });

  it('test_invocation_without_user_content', async () => {
    const {evaluator, judge} = createEvaluator();

    await evaluator.evaluateInvocations([
      createInvocation({
        userParts: [],
        agentText: 'Agent response.',
        rubrics: RUBRICS,
      }),
    ]);

    const prompt = sentPrompt(judge);
    expect(prompt).toContain(
      '<conversation_history>\nAGENT (agent) TURN 1: Agent response.\n' +
        '</conversation_history>',
    );
    expect(prompt).not.toContain('USER TURN');
  });
});
