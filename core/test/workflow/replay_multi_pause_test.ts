/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A workflow that pauses more than once, resumed across three turns.
 *
 * The replay sequence barrier is seeded from session history and advanced by
 * the resumed turn's own run ids. The two numberings have to agree, or a key
 * the sequence expects never arrives and every later key starves. A gate that
 * interrupts in one turn and produces its output in the next writes two
 * terminal events for one activation, which is where they came apart.
 */

import {Content} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createResumabilityConfig} from '../../src/apps/resumability_config.js';
import {Event} from '../../src/events/event.js';
import {InMemoryRunner} from '../../src/runner/in_memory_runner.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {RequestInput} from '../../src/workflow/request_input.js';
import {replaySequence} from '../../src/workflow/utils/rehydration_utils.js';
import {Workflow} from '../../src/workflow/workflow.js';

const text = (value: string): Content => ({
  role: 'user',
  parts: [{text: value}],
});

const reply = (id: string, value: string): Content => ({
  role: 'user',
  parts: [
    {
      functionResponse: {
        id,
        name: 'adk_request_input',
        response: {result: value},
      },
    },
  ],
});

function pendingInterruptId(events: Event[]): string {
  const id = events
    .flatMap((e) => e.content?.parts ?? [])
    .find((p) => p.functionCall)?.functionCall?.id;
  expect(id, 'the turn should have paused on an interrupt').toBeDefined();
  return id!;
}

/** `gate1 -> mid -> gate2 -> done`, pausing at each gate. */
function twoGatePipeline(name: string): Workflow {
  const gate1 = node(() => new RequestInput({message: 'first?'}), {
    name: 'gate1',
    rerunOnResume: false,
  });
  const mid = node((_c: NodeContext, input: string) => `mid(${input})`, {
    name: 'mid',
  });
  const gate2 = node(() => new RequestInput({message: 'second?'}), {
    name: 'gate2',
    rerunOnResume: false,
  });
  const done = node((_c: NodeContext, input: string) => `done(${input})`, {
    name: 'done',
  });
  return new Workflow({name, edges: [['START', gate1, mid, gate2, done]]});
}

async function driveThreeTurns(wf: Workflow, isResumable: boolean) {
  const runner = new InMemoryRunner({
    agent: wf,
    appName: 'app',
    ...(isResumable
      ? {resumabilityConfig: createResumabilityConfig({isResumable: true})}
      : {}),
  });
  const session = await runner.sessionService.createSession({
    appName: 'app',
    userId: 'u',
  });
  const turn = async (message: Content): Promise<Event[]> => {
    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u',
      sessionId: session.id,
      newMessage: message,
    })) {
      events.push(event);
    }
    return events;
  };

  const turn1 = await turn(text('go'));
  const turn2 = await turn(reply(pendingInterruptId(turn1), 'one'));
  const turn3 = await turn(reply(pendingInterruptId(turn2), 'two'));
  return {
    turn3,
    session: await runner.sessionService.getSession({
      appName: 'app',
      userId: 'u',
      sessionId: session.id,
    }),
  };
}

describe('Workflow replay across more than one pause', () => {
  it('completes the third turn instead of stalling the barrier', async () => {
    const {turn3} = await driveThreeTurns(twoGatePipeline('two_gates'), false);

    expect(turn3.map((e) => e.output).filter((o) => o !== undefined)).toContain(
      'done(two)',
    );
  }, 20000);

  it('completes the third turn on a resumable app too', async () => {
    const {turn3} = await driveThreeTurns(
      twoGatePipeline('two_gates_resumable'),
      true,
    );

    expect(turn3.map((e) => e.output).filter((o) => o !== undefined)).toContain(
      'done(two)',
    );
  }, 20000);

  it('does not count a re-emitted replayed output as another completion', async () => {
    const {session} = await driveThreeTurns(
      twoGatePipeline('reemit_scan'),
      true,
    );

    // Every key the scan reports has to be one the next turn would produce.
    // A workflow-authored replay echo is not a node completing again.
    const sequence = replaySequence(session!.events, 'reemit_scan');

    expect(new Set(sequence).size).toBe(sequence.length);
  }, 20000);
});
