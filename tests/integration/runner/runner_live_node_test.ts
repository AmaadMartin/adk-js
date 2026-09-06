/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A live run of a `Workflow` root against the in-memory services, with no model
 * and no network. It drives the whole runner path — live invocation context,
 * node driver, event queue merge, session persistence — rather than the driver
 * alone.
 */

import {
  createEvent,
  Event,
  InMemoryArtifactService,
  InMemorySessionService,
  LiveRequestQueue,
  node,
  NodeContext,
  Runner,
  Workflow,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'live_node_integration';
const USER_ID = 'integration-user';

/** A two-step graph: the first step reports progress, the second answers. */
function reviewWorkflow(): Workflow {
  const progress = node(
    (ctx: NodeContext) => {
      ctx.emit(
        createEvent({
          author: 'progress',
          content: {role: 'model', parts: [{text: 'reviewing'}]},
        }),
      );
      return 'reviewed';
    },
    {name: 'progress'},
  );
  const answer = node((_ctx: NodeContext, input: string) => `${input}: ok`, {
    name: 'answer',
  });
  return new Workflow({
    name: 'review',
    edges: [
      ['START', progress],
      [progress, answer],
    ],
  });
}

async function runLive(): Promise<{events: Event[]; stored: Event[]}> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  const runner = new Runner({
    appName: APP_NAME,
    agent: reviewWorkflow(),
    sessionService,
    artifactService: new InMemoryArtifactService(),
  });

  const liveRequestQueue = new LiveRequestQueue();
  const events: Event[] = [];
  for await (const event of runner.runLive({
    userId: USER_ID,
    sessionId: session.id,
    liveRequestQueue,
  })) {
    events.push(event);
  }
  liveRequestQueue.close();

  const stored = await sessionService.getSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: session.id,
  });
  return {events, stored: stored!.events};
}

describe('a Workflow root in live mode', () => {
  it('yields the events the graph produces, in order', async () => {
    const {events} = await runLive();

    expect(events.map((e) => e.content?.parts?.[0]?.text)).toContain(
      'reviewing',
    );
    expect(events.at(-1)?.output).toBe('reviewed: ok');
  });

  it('holds the non-partial events in the session', async () => {
    const {events, stored} = await runLive();

    expect(stored.length).toBe(events.length);
    expect(stored.map((e) => e.output)).toContain('reviewed: ok');
  });
});
