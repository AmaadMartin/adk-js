/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A resumable app persists a workflow's progress: a node checkpoint on
 * `actions.agentState`, then an end-of-agent marker. This drives the real
 * `Runner` and reads the events back out of the session service, which is the
 * cross-language contract — a unit test against a stub event channel cannot
 * show that the checkpoints survive the write.
 */

import {
  Event,
  InMemorySessionService,
  node,
  NodeContext,
  Runner,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** The node statuses of each `{nodes: ...}` snapshot, oldest first. */
function statusSnapshots(events: Event[]): Array<Record<string, number>> {
  return events
    .map((e) => e.actions?.agentState)
    .filter(
      (state): state is {nodes: Record<string, {status: number}>} =>
        state !== undefined && 'nodes' in state,
    )
    .map((state) =>
      Object.fromEntries(
        Object.entries(state.nodes).map(([name, n]) => [name, n.status]),
      ),
    );
}

describe('workflow integration — resumable checkpoints', () => {
  it('persists a checkpoint per node and an end-of-agent marker', async () => {
    const first = node((_c: NodeContext, input: string) => `first(${input})`, {
      name: 'first',
    });
    const second = node(
      (_c: NodeContext, input: string) => `second(${input})`,
      {name: 'second'},
    );
    const wf = new Workflow({
      name: 'resumable_wf',
      edges: [['START', first, second]],
    });

    const sessionService = new InMemorySessionService();
    const created = await sessionService.createSession({
      appName: 'app',
      userId: 'u1',
    });
    const runner = new Runner({
      appName: 'app',
      agent: wf,
      sessionService,
      resumabilityConfig: {isResumable: true},
    });
    for await (const _ of runner.runAsync({
      userId: 'u1',
      sessionId: created.id,
      newMessage: {role: 'user', parts: [{text: 'x'}]},
    })) {
      // Drain the stream; the assertions read the persisted session instead.
    }

    const session = await sessionService.getSession({
      appName: 'app',
      userId: 'u1',
      sessionId: created.id,
    });
    const events = session!.events;

    // RUNNING=2, COMPLETED=3 — the wire values NodeStatus persists.
    expect(statusSnapshots(events)).toEqual([
      {first: 2},
      {first: 3},
      {first: 3, second: 2},
      {first: 3, second: 3},
    ]);

    const endIndex = events.findIndex((e) => e.actions?.endOfAgent === true);
    const lastCheckpoint = events.findLastIndex(
      (e) => e.actions?.agentState !== undefined,
    );
    expect(endIndex).toBeGreaterThan(lastCheckpoint);
  });

  it('writes neither on an app that is not resumable', async () => {
    const only = node(() => 'done', {name: 'only'});
    const wf = new Workflow({name: 'plain_wf', edges: [['START', only]]});

    const sessionService = new InMemorySessionService();
    const created = await sessionService.createSession({
      appName: 'app',
      userId: 'u1',
    });
    const runner = new Runner({appName: 'app', agent: wf, sessionService});
    for await (const _ of runner.runAsync({
      userId: 'u1',
      sessionId: created.id,
      newMessage: {role: 'user', parts: [{text: 'x'}]},
    })) {
      // Drain the stream; the assertions read the persisted session instead.
    }

    const session = await sessionService.getSession({
      appName: 'app',
      userId: 'u1',
      sessionId: created.id,
    });
    expect(statusSnapshots(session!.events)).toEqual([]);
    expect(session!.events.some((e) => e.actions?.endOfAgent === true)).toBe(
      false,
    );
  });
});
