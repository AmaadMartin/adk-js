/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseAgentConfig,
  createEvent,
  createResumabilityConfig,
  createSession,
  Event,
  FunctionTool,
  InMemorySessionService,
  InvocationContext,
  isSequentialAgent,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  Runner,
  SequentialAgent,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

class MockSubAgent extends BaseAgent {
  private eventsToYield: Event[];

  constructor(config: BaseAgentConfig, eventsToYield: Event[]) {
    super(config);
    this.eventsToYield = eventsToYield;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    for (const event of this.eventsToYield) {
      yield {
        ...event,
        invocationId: context.invocationId,
        branch: context.branch,
      };
    }
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

function makeContext(agent: BaseAgent): InvocationContext {
  const session = createSession({
    id: 'test-session',
    appName: 'test-app',
  });
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session,
    pluginManager: new PluginManager(),
  });
}

describe('SequentialAgent', () => {
  it('should be identified by isSequentialAgent', () => {
    const agent = new SequentialAgent({name: 'seq'});
    expect(isSequentialAgent(agent)).toBe(true);
  });

  it('should return false for non-SequentialAgent objects', () => {
    expect(isSequentialAgent(null)).toBe(false);
    expect(isSequentialAgent(undefined)).toBe(false);
    expect(isSequentialAgent({})).toBe(false);
    expect(isSequentialAgent('string')).toBe(false);
  });

  it('should run sub-agents in sequential order', async () => {
    const event1 = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'from sub1'}]},
    });
    const event2 = createEvent({
      author: 'sub2',
      content: {role: 'model', parts: [{text: 'from sub2'}]},
    });

    const sub1 = new MockSubAgent({name: 'sub1'}, [event1]);
    const sub2 = new MockSubAgent({name: 'sub2'}, [event2]);

    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [sub1, sub2],
    });

    const context = makeContext(seq);

    const yieldedEvents: Event[] = [];
    for await (const event of seq.runAsync(context)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(2);
    // sub1 must come before sub2 (sequential order)
    expect(yieldedEvents[0].author).toBe('sub1');
    expect(yieldedEvents[1].author).toBe('sub2');
  });

  it('should yield all events from each sub-agent before moving to the next', async () => {
    const sub1Events = [
      createEvent({
        author: 'sub1',
        content: {role: 'model', parts: [{text: 'sub1 event 1'}]},
      }),
      createEvent({
        author: 'sub1',
        content: {role: 'model', parts: [{text: 'sub1 event 2'}]},
      }),
    ];
    const sub2Events = [
      createEvent({
        author: 'sub2',
        content: {role: 'model', parts: [{text: 'sub2 event 1'}]},
      }),
    ];

    const sub1 = new MockSubAgent({name: 'sub1'}, sub1Events);
    const sub2 = new MockSubAgent({name: 'sub2'}, sub2Events);

    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [sub1, sub2],
    });

    const context = makeContext(seq);

    const authors: Array<string | undefined> = [];
    for await (const event of seq.runAsync(context)) {
      authors.push(event.author);
    }

    expect(authors).toEqual(['sub1', 'sub1', 'sub2']);
  });

  it('should yield no events when there are no sub-agents', async () => {
    const seq = new SequentialAgent({name: 'seq', subAgents: []});
    const context = makeContext(seq);

    const yieldedEvents: Event[] = [];
    for await (const event of seq.runAsync(context)) {
      yieldedEvents.push(event);
    }

    expect(yieldedEvents.length).toBe(0);
  });

  it('should propagate invocationId to sub-agent events', async () => {
    const event = createEvent({
      author: 'sub1',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });
    const sub1 = new MockSubAgent({name: 'sub1'}, [event]);
    const seq = new SequentialAgent({name: 'seq', subAgents: [sub1]});
    const context = makeContext(seq);

    const yieldedEvents: Event[] = [];
    for await (const e of seq.runAsync(context)) {
      yieldedEvents.push(e);
    }

    expect(yieldedEvents[0].invocationId).toBe('test-invocation');
  });

  it('should handle single sub-agent', async () => {
    const event = createEvent({
      author: 'only_sub',
      content: {role: 'model', parts: [{text: 'only response'}]},
    });
    const sub = new MockSubAgent({name: 'only_sub'}, [event]);
    const seq = new SequentialAgent({name: 'seq', subAgents: [sub]});
    const context = makeContext(seq);

    const yieldedEvents: Event[] = [];
    for await (const e of seq.runAsync(context)) {
      yieldedEvents.push(e);
    }

    expect(yieldedEvents.length).toBe(1);
    expect(yieldedEvents[0].author).toBe('only_sub');
  });
});

/** A sub-agent that yields one event on the live path. */
class LiveSubAgent extends BaseAgent {
  constructor(name: string) {
    super({name});
  }

  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {role: 'model', parts: [{text: `live ${this.name}`}]},
    });
  }
}

/** An LlmAgent whose live run yields nothing, so no model is contacted. */
class SilentLiveLlmAgent extends LlmAgent {
  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

/** A sub-agent that yields one event carrying a long-running function call. */
class PausingSubAgent extends BaseAgent {
  constructor(
    config: BaseAgentConfig,
    private readonly callId: string,
  ) {
    super(config);
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {
        role: 'model',
        parts: [{functionCall: {id: this.callId, name: 'ask_human', args: {}}}],
      },
      longRunningToolIds: [this.callId],
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

function makeResumableContext(agent: BaseAgent): InvocationContext {
  const session = createSession({id: 'test-session', appName: 'test-app'});
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session,
    pluginManager: new PluginManager(),
    resumabilityConfig: createResumabilityConfig({isResumable: true}),
  });
}

function makeSubAgent(name: string): MockSubAgent {
  return new MockSubAgent({name}, [
    createEvent({
      author: name,
      content: {role: 'model', parts: [{text: `from ${name}`}]},
    }),
  ]);
}

async function collect(
  agent: BaseAgent,
  context: InvocationContext,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of agent.runAsync(context)) {
    events.push(event);
  }
  return events;
}

describe('SequentialAgent resumability', () => {
  it('emits a checkpoint before each sub-agent and an end-of-agent event', async () => {
    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [makeSubAgent('sub1'), makeSubAgent('sub2')],
    });
    const context = makeResumableContext(seq);

    const events = await collect(seq, context);

    expect(events.map((e) => e.author)).toEqual([
      'seq',
      'sub1',
      'seq',
      'sub2',
      'seq',
    ]);
    expect(events[0].actions.agentState).toEqual({current_sub_agent: 'sub1'});
    expect(events[0].actions.endOfAgent).toBeFalsy();
    expect(events[2].actions.agentState).toEqual({current_sub_agent: 'sub2'});
    expect(events[2].actions.endOfAgent).toBeFalsy();
    expect(events[4].actions.endOfAgent).toBe(true);
    expect(events[4].actions.agentState).toBeUndefined();
  });

  it('resumes at the recorded sub-agent without re-running earlier ones', async () => {
    const sub1 = makeSubAgent('sub1');
    const sub2 = makeSubAgent('sub2');
    const seq = new SequentialAgent({name: 'seq', subAgents: [sub1, sub2]});
    const context = makeResumableContext(seq);
    context.setAgentState('seq', {agentState: {current_sub_agent: 'sub2'}});

    const events = await collect(seq, context);

    // Only sub2's event and the end-of-agent event: sub2's own checkpoint is
    // already in history, and sub1 must not run again.
    expect(events.map((e) => e.author)).toEqual(['sub2', 'seq']);
    expect(events[1].actions.endOfAgent).toBe(true);
  });

  it('emits a checkpoint for every sub-agent after the resumed one', async () => {
    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [
        makeSubAgent('sub1'),
        makeSubAgent('sub2'),
        makeSubAgent('sub3'),
      ],
    });
    const context = makeResumableContext(seq);
    context.setAgentState('seq', {agentState: {current_sub_agent: 'sub2'}});

    const events = await collect(seq, context);

    expect(events.map((e) => e.author)).toEqual(['sub2', 'seq', 'sub3', 'seq']);
    expect(events[1].actions.agentState).toEqual({current_sub_agent: 'sub3'});
  });

  it('runs no sub-agent when the recorded state says the run finished', async () => {
    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [makeSubAgent('sub1'), makeSubAgent('sub2')],
    });
    const context = makeResumableContext(seq);
    context.setAgentState('seq', {agentState: {current_sub_agent: ''}});

    const events = await collect(seq, context);

    expect(events.map((e) => e.author)).toEqual(['seq']);
    expect(events[0].actions.endOfAgent).toBe(true);
  });

  it('restarts from the beginning when the recorded sub-agent was removed', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [makeSubAgent('sub1'), makeSubAgent('sub2')],
    });
    const context = makeResumableContext(seq);
    context.setAgentState('seq', {agentState: {current_sub_agent: 'gone'}});

    const events = await collect(seq, context);

    // Both sub-agents run again. The first checkpoint is still suppressed,
    // because a state was present, matching adk-python.
    expect(events.map((e) => e.author)).toEqual(['sub1', 'seq', 'sub2', 'seq']);
    expect(events[1].actions.agentState).toEqual({current_sub_agent: 'sub2'});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gone'));
    warn.mockRestore();
  });

  it('rejects a checkpoint whose sub-agent name is not a string', async () => {
    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [makeSubAgent('sub1')],
    });
    const context = makeResumableContext(seq);
    context.setAgentState('seq', {agentState: {current_sub_agent: 42}});

    await expect(collect(seq, context)).rejects.toThrowError(
      /"current_sub_agent" must be a string, got number/,
    );
  });

  it('rejects a checkpoint carrying an unexpected field', async () => {
    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [makeSubAgent('sub1')],
    });
    const context = makeResumableContext(seq);
    context.setAgentState('seq', {
      agentState: {current_sub_agent: 'sub1', extra: 1},
    });

    await expect(collect(seq, context)).rejects.toThrowError(
      /unexpected field "extra"/,
    );
  });

  it('treats a checkpoint with no recorded name as a finished run', async () => {
    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [makeSubAgent('sub1')],
    });
    const context = makeResumableContext(seq);
    context.setAgentState('seq', {agentState: {}});

    const events = await collect(seq, context);

    expect(events.map((e) => e.author)).toEqual(['seq']);
    expect(events[0].actions.endOfAgent).toBe(true);
  });

  it('stops the sequence and skips the end-of-agent event when paused', async () => {
    const sub2 = makeSubAgent('sub2');
    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [new PausingSubAgent({name: 'sub1'}, 'call-1'), sub2],
    });
    const context = makeResumableContext(seq);

    const events = await collect(seq, context);

    expect(events.map((e) => e.author)).toEqual(['seq', 'sub1']);
    expect(events.some((e) => e.actions.endOfAgent)).toBe(false);
    // The checkpoint still names sub1, so the next invocation re-enters there.
    expect(context.agentStates['seq']).toEqual({current_sub_agent: 'sub1'});
  });

  it('drains the paused sub-agent before returning', async () => {
    const chatty = new MockSubAgent({name: 'sub1'}, [
      createEvent({
        author: 'sub1',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'call-1', name: 'ask_human', args: {}}}],
        },
        longRunningToolIds: ['call-1'],
      }),
      createEvent({
        author: 'sub1',
        content: {role: 'model', parts: [{text: 'trailing'}]},
      }),
    ]);
    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [chatty, makeSubAgent('sub2')],
    });
    const context = makeResumableContext(seq);

    const events = await collect(seq, context);

    expect(events.map((e) => e.author)).toEqual(['seq', 'sub1', 'sub1']);
  });

  it('emits no events at all for an empty sub-agent list', async () => {
    const seq = new SequentialAgent({name: 'seq', subAgents: []});
    const context = makeResumableContext(seq);

    expect(await collect(seq, context)).toEqual([]);
  });

  it('emits no checkpoint events when the app is not resumable', async () => {
    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [makeSubAgent('sub1'), makeSubAgent('sub2')],
    });
    const context = makeContext(seq);

    const events = await collect(seq, context);

    expect(events.map((e) => e.author)).toEqual(['sub1', 'sub2']);
    for (const event of events) {
      expect(event.actions.agentState).toBeUndefined();
      expect(event.actions.endOfAgent).toBeUndefined();
    }
    expect(context.agentStates).toEqual({});
  });

  it('does not pause a non-resumable run', async () => {
    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [
        new PausingSubAgent({name: 'sub1'}, 'call-1'),
        makeSubAgent('sub2'),
      ],
    });
    const context = makeContext(seq);

    // shouldPauseInvocation does not depend on resumability, so sub2 is still
    // skipped; only the checkpoint events are absent.
    const events = await collect(seq, context);

    expect(events.map((e) => e.author)).toEqual(['sub1']);
  });
});

describe('SequentialAgent live mode', () => {
  async function collectLive(
    agent: SequentialAgent,
    context: InvocationContext,
  ): Promise<Event[]> {
    const events: Event[] = [];
    for await (const event of agent.runLive(context)) {
      events.push(event);
    }
    return events;
  }

  it('keeps an instruction provider callable', async () => {
    const sub = new SilentLiveLlmAgent({
      name: 'sub1',
      instruction: async () => 'base instruction.',
    });
    const seq = new SequentialAgent({name: 'seq', subAgents: [sub]});
    const context = makeContext(seq);

    await collectLive(seq, context);

    expect(typeof sub.instruction).toBe('function');
    if (typeof sub.instruction !== 'function') {
      expect.fail('instruction must stay a provider');
    }
    const resolved = await sub.instruction(new ReadonlyContext(context));
    expect(resolved).toContain('base instruction.');
    expect(resolved).toContain('task_completed');
  });

  it('appends to a string instruction and adds the tool once', async () => {
    const sub = new SilentLiveLlmAgent({
      name: 'sub1',
      instruction: 'base instruction.',
    });
    const seq = new SequentialAgent({name: 'seq', subAgents: [sub]});

    await collectLive(seq, makeContext(seq));
    await collectLive(seq, makeContext(seq));

    expect(typeof sub.instruction).toBe('string');
    expect(sub.instruction).toContain('base instruction.');
    expect(
      sub.tools.filter(
        (tool) =>
          tool instanceof FunctionTool && tool.name === 'task_completed',
      ),
    ).toHaveLength(1);
    // The suffix is appended once, alongside the single tool.
    expect(String(sub.instruction).split('task_completed').length - 1).toBe(1);
  });

  it('forwards the events of each sub-agent in order', async () => {
    const seq = new SequentialAgent({
      name: 'seq',
      subAgents: [new LiveSubAgent('sub1'), new LiveSubAgent('sub2')],
    });

    const events = await collectLive(seq, makeContext(seq));

    expect(events.map((e) => e.author)).toEqual(['sub1', 'sub2']);
  });

  it('emits no events for an empty sub-agent list', async () => {
    const seq = new SequentialAgent({name: 'seq', subAgents: []});

    expect(await collectLive(seq, makeContext(seq))).toEqual([]);
  });
});

/** Yields a long-running call on its first run and a plain event afterwards. */
class HumanInTheLoopAgent extends BaseAgent {
  runCount = 0;

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.runCount++;
    if (this.runCount === 1) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        branch: context.branch,
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'ask-1', name: 'ask_human', args: {}}}],
        },
        longRunningToolIds: ['ask-1'],
      });
      return;
    }
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {role: 'model', parts: [{text: 'human answered'}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

/** Counts how many times it ran, so a resume can prove it did not re-run. */
class CountingAgent extends BaseAgent {
  runCount = 0;

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    this.runCount++;
    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      branch: context.branch,
      content: {role: 'model', parts: [{text: `${this.name} ran`}]},
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

describe('SequentialAgent resume through a Runner', () => {
  it('pauses on a long-running call and resumes at the same sub-agent', async () => {
    const research = new CountingAgent({name: 'research'});
    const review = new HumanInTheLoopAgent({name: 'review'});
    const publish = new CountingAgent({name: 'publish'});
    const seq = new SequentialAgent({
      name: 'pipeline',
      subAgents: [research, review, publish],
    });
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: 'app',
      userId: 'u',
      sessionId: 's',
    });
    const runner = new Runner({
      appName: 'app',
      agent: seq,
      sessionService,
      resumabilityConfig: createResumabilityConfig({isResumable: true}),
    });

    const first: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u',
      sessionId: 's',
      invocationId: 'e-run-1',
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      first.push(event);
    }

    expect(first.map((e) => e.author)).toEqual([
      'pipeline',
      'research',
      'pipeline',
      'review',
    ]);
    expect(publish.runCount).toBe(0);
    expect(first.some((e) => e.actions.endOfAgent)).toBe(false);

    const second: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'u',
      sessionId: 's',
      invocationId: 'e-run-1',
      newMessage: {role: 'user', parts: [{text: 'approved'}]},
    })) {
      second.push(event);
    }

    // research is not re-run; the pipeline picks up at review.
    expect(research.runCount).toBe(1);
    expect(publish.runCount).toBe(1);
    expect(second.map((e) => e.author)).toEqual([
      'review',
      'pipeline',
      'publish',
      'pipeline',
    ]);
    expect(second[3].actions.endOfAgent).toBe(true);
  });
});
