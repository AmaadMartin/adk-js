/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  InMemorySessionService,
  Runner,
  Workflow,
  node,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'isolated_app';
const USER_ID = 'u1';
const SESSION_ID = 's1';

/**
 * A workflow whose only step declares an isolation scope while being an
 * ordinary function node. Such a node never emits `finish_task`, so its scope
 * never closes.
 */
function isolatedWorkflow(): Workflow {
  return new Workflow({
    name: 'wf',
    edges: [
      ['START', node(() => 'done', {name: 'isolated', isolationScope: true})],
    ],
  });
}

async function newRunner(): Promise<Runner> {
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });
  return new Runner({
    appName: APP_NAME,
    agent: isolatedWorkflow(),
    sessionService,
  });
}

async function say(runner: Runner, text: string): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId: SESSION_ID,
    newMessage: {role: 'user', parts: [{text}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('a user turn after a node that declared an isolation scope', () => {
  it('starts its own invocation and carries no scope', async () => {
    const runner = await newRunner();

    await say(runner, 'one');
    await say(runner, 'two');

    const session = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const userEvents = (session?.events ?? []).filter(
      (event) => event.author === 'user',
    );

    expect(userEvents.map((event) => event.content?.parts?.[0]?.text)).toEqual([
      'one',
      'two',
    ]);
    expect(userEvents[1].isolationScope).toBeUndefined();
    expect(userEvents[1].invocationId).not.toBe(userEvents[0].invocationId);
  });

  it('runs the graph again instead of replaying the first invocation', async () => {
    const runner = await newRunner();

    const first = await say(runner, 'one');
    const second = await say(runner, 'two');

    expect(second.length).toBeGreaterThan(0);
    expect(second[0].invocationId).not.toBe(first[0].invocationId);
  });
});
