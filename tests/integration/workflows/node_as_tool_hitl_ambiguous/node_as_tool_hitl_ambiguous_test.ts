/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for an ambiguous plain-text HITL reply through a node-tool.
 *
 * A node-tool that pauses on two interrupts at once cannot be answered by
 * typing: the text names no interrupt, so it resolves nothing and the pauses
 * stay open. A node-tool that pauses on one interrupt per turn still resumes by
 * typing, turn after turn.
 */

import type {NodeContext} from '@google/adk';
import {
  getFunctionCalls,
  getFunctionResponses,
  InMemoryRunner,
  node,
  RequestInput,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  collect,
  functionCallResponse,
  mockLlmAgent,
  textResponse,
} from '../_harness/workflow_test_utils.js';

/** A node-tool that raises both of its interrupts in a single run. */
const twoGates = node(
  async function* (ctx: NodeContext, args: {tier: string}) {
    const a = ctx.resumeInputs['gate_a'];
    const b = ctx.resumeInputs['gate_b'];
    if (a === undefined || b === undefined) {
      yield new RequestInput({interruptId: 'gate_a', message: 'a?'});
      yield new RequestInput({interruptId: 'gate_b', message: 'b?'});
      return;
    }
    yield `resolved a=${String(a)} b=${String(b)} tier=${args.tier}`;
  },
  {
    name: 'two_gates',
    inputSchema: z.object({tier: z.string()}),
    rerunOnResume: true,
  },
);

/** A node-tool that raises exactly one interrupt, named by its argument. */
const oneGate = node(
  async function* (ctx: NodeContext, args: {which: string}) {
    const answer = ctx.resumeInputs[args.which];
    if (answer === undefined) {
      yield new RequestInput({interruptId: args.which, message: 'ok?'});
      return;
    }
    yield `resolved ${args.which}=${String(answer)}`;
  },
  {
    name: 'one_gate',
    inputSchema: z.object({which: z.string()}),
    rerunOnResume: true,
  },
);

describe('workflow integration — ambiguous plain-text resume through a node-tool', () => {
  it('resolves nothing when two interrupts are pending', async () => {
    const agent = mockLlmAgent(
      {
        name: 'gate_agent',
        instruction: 'Run the gates.',
        tools: [twoGates],
      },
      [
        functionCallResponse('two_gates', {tier: 'x'}, 'call-1'),
        textResponse('Which gate did you mean?'),
      ],
    );

    const runner = new InMemoryRunner({agent, appName: agent.name});
    const session = await runner.sessionService.createSession({
      appName: agent.name,
      userId: 'u1',
    });
    const run = (text: string) =>
      collect(
        runner.runAsync({
          userId: 'u1',
          sessionId: session.id,
          newMessage: {role: 'user', parts: [{text}]},
        }),
      );

    // Turn 1: the model calls the node-tool, which pauses on both interrupts.
    const turn1 = await run('What do I get?');
    const raised = turn1
      .flatMap((e) => getFunctionCalls(e))
      .filter((fc) => fc.name === 'adk_request_input')
      .map((fc) => fc.id);
    expect(raised).toEqual(['gate_a', 'gate_b']);

    // Turn 2: plain text names neither interrupt, so the node-tool is not
    // re-run and the message is handled as an ordinary user turn.
    const turn2 = await run('yes');
    const resolved = turn2
      .flatMap((e) => getFunctionResponses(e))
      .find((fr) => fr.name === 'two_gates');
    expect(resolved).toBeUndefined();
    expect(turn2.at(-1)?.content?.parts?.[0]?.text).toBe(
      'Which gate did you mean?',
    );
  });

  it('still resumes a second pause raised after an earlier one was typed', async () => {
    const agent = mockLlmAgent(
      {
        name: 'gate_agent',
        instruction: 'Run the gates.',
        tools: [oneGate],
      },
      [
        functionCallResponse('one_gate', {which: 'confirm_a'}, 'call-1'),
        functionCallResponse('one_gate', {which: 'confirm_b'}, 'call-2'),
        textResponse('Both gates are done.'),
      ],
    );

    const runner = new InMemoryRunner({agent, appName: agent.name});
    const session = await runner.sessionService.createSession({
      appName: agent.name,
      userId: 'u1',
    });
    const run = (text: string) =>
      collect(
        runner.runAsync({
          userId: 'u1',
          sessionId: session.id,
          newMessage: {role: 'user', parts: [{text}]},
        }),
      );

    await run('start');
    // Turn 2 resolves the first pause by typing, and the model calls the
    // node-tool again, which pauses on a second interrupt.
    const turn2 = await run('yes');
    expect(
      turn2
        .flatMap((e) => getFunctionResponses(e))
        .find((fr) => fr.name === 'one_gate')?.response,
    ).toMatchObject({result: 'resolved confirm_a=yes'});

    // Turn 3: the first pause left no functionResponse behind, so it is still
    // unanswered in the session. It must not make this reply ambiguous.
    const turn3 = await run('sure');
    expect(
      turn3
        .flatMap((e) => getFunctionResponses(e))
        .find((fr) => fr.name === 'one_gate')?.response,
    ).toMatchObject({result: 'resolved confirm_b=sure'});
  });
});
