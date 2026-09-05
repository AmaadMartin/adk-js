/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test for the invocation event queue: a `Workflow` runs as an
 * `LlmAgent` tool and emits several events. Each one waits for the agent's
 * drain loop to take it, so the agent's output stream carries them in
 * emission order and the run finishes rather than deadlocking.
 */

import {InMemoryRunner, node, NodeContext, Workflow} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  collect,
  functionCallResponse,
  mockLlmAgent,
  textResponse,
} from '../_harness/workflow_test_utils.js';

const STEP_COUNT = 5;

describe('workflow integration — node events reach the agent in order', () => {
  it('interleaves every node event into the agent output stream', async () => {
    const counter = node(
      function* (_c: NodeContext, args: {upTo: number}) {
        for (let step = 1; step <= args.upTo; step++) {
          yield `step-${step}`;
        }
      },
      {name: 'counter', inputSchema: z.object({upTo: z.number()})},
    );
    const countingWorkflow = new Workflow({
      name: 'counting_workflow',
      description: 'Counts up to the requested number, one event per step.',
      inputSchema: z.object({upTo: z.number()}),
      edges: [['START', counter]],
    });

    const agent = mockLlmAgent(
      {
        name: 'counting_agent',
        instruction: 'Count for the user.',
        tools: [countingWorkflow],
      },
      [
        functionCallResponse('counting_workflow', {upTo: STEP_COUNT}),
        textResponse('Counted.'),
      ],
    );

    const runner = new InMemoryRunner({agent, appName: agent.name});
    const session = await runner.sessionService.createSession({
      appName: agent.name,
      userId: 'u1',
    });
    const events = await collect(
      runner.runAsync({
        userId: 'u1',
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text: 'count to five'}]},
      }),
    );

    const steps = events
      .map((event) => event.output)
      .filter((output): output is string => typeof output === 'string')
      .filter((output) => output.startsWith('step-'));

    expect(steps).toEqual(['step-1', 'step-2', 'step-3', 'step-4', 'step-5']);
  });
});
