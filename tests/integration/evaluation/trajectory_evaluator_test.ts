/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EvalStatus,
  FunctionTool,
  getFunctionCalls,
  InMemoryRunner,
  Invocation,
  LlmAgent,
  TrajectoryEvaluator,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {GeminiWithMockResponses} from '../test_case_utils.js';

const APP_NAME = 'trajectory_eval_app';
const USER_ID = 'test_user';
const PROMPT = 'Roll a 16 sided die';

/** Runs the agent once and returns the trajectory the run actually produced. */
async function runAgent(): Promise<Invocation> {
  const rollDie = new FunctionTool({
    name: 'roll_die',
    description: 'Rolls a die with the given number of sides.',
    parameters: z.object({sides: z.number()}),
    execute: ({sides}) => ({result: sides}),
  });

  const agent = new LlmAgent({
    name: 'dice_agent',
    description: 'Rolls dice on request.',
    instruction: 'Call roll_die when the user asks for a die roll.',
    tools: [rollDie],
  });
  agent.model = new GeminiWithMockResponses([
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{functionCall: {name: 'roll_die', args: {sides: 16}}}],
          },
        },
      ],
    },
    {
      candidates: [
        {
          content: {role: 'model', parts: [{text: 'You rolled a 16.'}]},
        },
      ],
    },
  ]);

  const runner = new InMemoryRunner({agent, appName: APP_NAME});
  const session = await runner.sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });

  const newMessage = createUserContent(PROMPT);
  for await (const _ of runner.runAsync({
    userId: USER_ID,
    sessionId: session.id,
    newMessage,
  })) {
    // The events are read back from the session below, so the loop only has to
    // drive the run to completion.
  }

  const finished = await runner.sessionService.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: session.id,
  });
  if (!finished) {
    expect.fail('the session disappeared while the agent ran');
  }

  return {
    userContent: newMessage,
    toolUses: finished.events.flatMap(getFunctionCalls),
  };
}

describe('TrajectoryEvaluator against a real agent run', () => {
  it('passes the run against the trajectory it produced', async () => {
    const actual = await runAgent();
    const expected: Invocation = {
      userContent: createUserContent(PROMPT),
      toolUses: [{name: 'roll_die', args: {sides: 16}}],
    };

    const result = await new TrajectoryEvaluator({
      threshold: 1.0,
    }).evaluateInvocations([actual], [expected]);

    expect(actual.toolUses).toHaveLength(1);
    expect(result.overallScore).toBe(1.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.PASSED);
  });

  it('fails the run against a trajectory it did not produce', async () => {
    const actual = await runAgent();
    const expected: Invocation = {
      userContent: createUserContent(PROMPT),
      toolUses: [{name: 'roll_die', args: {sides: 6}}],
    };

    const result = await new TrajectoryEvaluator({
      threshold: 1.0,
    }).evaluateInvocations([actual], [expected]);

    expect(result.overallScore).toBe(0.0);
    expect(result.overallEvalStatus).toBe(EvalStatus.FAILED);
  });
});
