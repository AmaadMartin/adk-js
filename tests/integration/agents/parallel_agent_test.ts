/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  BaseAgent,
  BaseAgentConfig,
  createEvent,
  createResumabilityConfig,
  Event,
  InMemorySessionService,
  InvocationContext,
  ParallelAgent,
  Runner,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'parallel_agent_app';
const USER_ID = 'test_user';
const SESSION_ID = 'test_session';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ReportingAgentConfig extends BaseAgentConfig {
  /** Milliseconds to wait before reporting. */
  delay?: number;
  /** Whether to end the fan-out after reporting. */
  escalate?: boolean;
}

/** Reports one finding, then records that it finished. */
class ReportingAgent extends BaseAgent<ReportingAgentConfig> {
  private readonly delay: number;
  private readonly escalate: boolean;

  constructor(config: ReportingAgentConfig) {
    super(config);
    this.delay = config.delay ?? 0;
    this.escalate = config.escalate ?? false;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    await sleep(this.delay);
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {role: 'model', parts: [{text: `${this.name} reporting`}]},
      actions: this.escalate ? {escalate: true} : {},
    });
    if (context.isResumable) {
      context.setAgentState(this.name, {endOfAgent: true});
    }
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    // The live path is not supported for a parallel fan-out.
  }
}

async function run(
  rootAgent: BaseAgent,
  isResumable: boolean,
): Promise<Event[]> {
  const sessionService = new InMemorySessionService();
  const runner = new Runner({
    app: new App({
      name: APP_NAME,
      rootAgent,
      resumabilityConfig: createResumabilityConfig({isResumable}),
    }),
    sessionService,
  });
  await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId: SESSION_ID,
    newMessage: {role: 'user', parts: [{text: 'go'}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('ParallelAgent through the Runner', () => {
  it('brackets a resumable fan-out with checkpoints on separate branches', async () => {
    const parallel = new ParallelAgent({
      name: 'research',
      subAgents: [
        new ReportingAgent({name: 'fast'}),
        new ReportingAgent({name: 'slow', delay: 30}),
      ],
    });

    const events = await run(parallel, true);

    expect(events.map((event) => event.author)).toEqual([
      'research',
      'fast',
      'slow',
      'research',
    ]);
    expect(events[0].actions.agentState).toEqual({});
    expect(events[1].branch).toBe('research.fast');
    expect(events[2].branch).toBe('research.slow');
    expect(events[3].actions.endOfAgent).toBe(true);
  });

  it('emits no checkpoint when the app is not resumable', async () => {
    const parallel = new ParallelAgent({
      name: 'research',
      subAgents: [
        new ReportingAgent({name: 'fast'}),
        new ReportingAgent({name: 'slow', delay: 30}),
      ],
    });

    const events = await run(parallel, false);

    expect(events.map((event) => event.author)).toEqual(['fast', 'slow']);
    expect(events.some((event) => event.actions.agentState)).toBe(false);
    expect(events.some((event) => event.actions.endOfAgent)).toBe(false);
  });

  it('stops the slow branch when a sub-agent escalates', async () => {
    const parallel = new ParallelAgent({
      name: 'research',
      subAgents: [
        new ReportingAgent({name: 'conclusive', escalate: true}),
        new ReportingAgent({name: 'slow', delay: 500}),
      ],
    });

    const events = await run(parallel, false);

    expect(events.map((event) => event.author)).toEqual(['conclusive']);
  });
});
