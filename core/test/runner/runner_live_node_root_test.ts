/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live mode used to accept an agent root only, refusing anything else with
 * `runLive is only supported for agents.`. A `Workflow` root now runs live
 * through the same node driver the async path uses.
 */

import {describe, expect, it} from 'vitest';
import {LiveRequestQueue} from '../../src/agents/live_request_queue.js';
import {createEvent, Event} from '../../src/events/event.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {node} from '../../src/workflow/node.js';
import {NodeContext} from '../../src/workflow/node_context.js';
import {Workflow} from '../../src/workflow/workflow.js';

const APP_NAME = 'live_node_app';
const USER_ID = 'u';

async function newRunner(root: Workflow) {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  const runner = new Runner({appName: APP_NAME, agent: root, sessionService});
  return {runner, session, sessionService};
}

describe('Runner.runLive with a node root', () => {
  it('yields the node events instead of refusing a non-agent root', async () => {
    const workflow = new Workflow({
      name: 'wf',
      edges: [['START', node(() => 'live-answer', {name: 'step'})]],
    });
    const {runner, session} = await newRunner(workflow);

    const events: Event[] = [];
    for await (const event of runner.runLive({
      userId: USER_ID,
      sessionId: session.id,
      liveRequestQueue: new LiveRequestQueue(),
    })) {
      events.push(event);
    }

    expect(events.map((e) => e.output).filter((o) => o !== undefined)).toEqual([
      'live-answer',
    ]);
  });

  it('appends the node events to the session', async () => {
    const workflow = new Workflow({
      name: 'wf',
      edges: [['START', node(() => 'persisted', {name: 'step'})]],
    });
    const {runner, session, sessionService} = await newRunner(workflow);

    for await (const _ of runner.runLive({
      userId: USER_ID,
      sessionId: session.id,
      liveRequestQueue: new LiveRequestQueue(),
    })) {
      // drain
    }

    const stored = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });
    expect(stored?.events.map((e) => e.output)).toContain('persisted');
  });

  it('propagates a node failure after the events it already produced', async () => {
    const workflow = new Workflow({
      name: 'wf',
      edges: [
        [
          'START',
          node(
            (ctx: NodeContext) => {
              ctx.emit(
                createEvent({
                  author: 'step',
                  content: {parts: [{text: 'progress'}]},
                }),
              );
              throw new Error('node blew up');
            },
            {name: 'step'},
          ),
        ],
      ],
    });
    const {runner, session} = await newRunner(workflow);

    const seen: Event[] = [];
    await expect(async () => {
      for await (const event of runner.runLive({
        userId: USER_ID,
        sessionId: session.id,
        liveRequestQueue: new LiveRequestQueue(),
      })) {
        seen.push(event);
      }
    }).rejects.toThrow('node blew up');

    expect(seen.map((e) => e.content?.parts?.[0]?.text)).toContain('progress');
  });

  it('leaves no running driver when the caller stops early', async () => {
    let finished = false;
    const workflow = new Workflow({
      name: 'wf',
      edges: [
        [
          'START',
          node(
            async (ctx: NodeContext) => {
              ctx.emit(
                createEvent({
                  author: 'step',
                  content: {parts: [{text: 'first'}]},
                }),
              );
              await new Promise((resolve) => setTimeout(resolve, 0));
              finished = true;
              return 'done';
            },
            {name: 'step'},
          ),
        ],
      ],
    });
    const {runner, session} = await newRunner(workflow);

    const stream = runner.runLive({
      userId: USER_ID,
      sessionId: session.id,
      liveRequestQueue: new LiveRequestQueue(),
    });
    for await (const _ of stream) {
      break;
    }

    expect(finished).toBe(true);
  });
});
