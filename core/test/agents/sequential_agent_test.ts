/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AsyncQueue,
  BaseAgent,
  BaseAgentConfig,
  BaseLlm,
  BaseLlmConnection,
  BaseTool,
  Context,
  createEvent,
  createSession,
  Event,
  FunctionTool,
  InMemorySessionService,
  InvocationContext,
  isSequentialAgent,
  LiveRequestQueue,
  LlmAgent,
  LlmResponse,
  PluginManager,
  ReadonlyContext,
  Runner,
  SequentialAgent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

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

const TASK_COMPLETED_SUFFIX =
  "If you finished the user's request according to its description, call the " +
  'task_completed function to exit so the next agents can take over. When ' +
  'calling this function, do not generate any text other than the function ' +
  'call.';

const LIVE_APP_NAME = 'live-app';
const LIVE_USER_ID = 'live-user';
const LIVE_SESSION_ID = 'live-session';

/** A live connection whose stream ends once its responses are drained. */
class FakeLiveConnection implements BaseLlmConnection {
  private readonly queue = new AsyncQueue<LlmResponse>();

  constructor(responses: LlmResponse[]) {
    for (const response of responses) {
      this.queue.push(response);
    }
    this.queue.close();
  }

  async sendHistory(): Promise<void> {}
  async sendContent(): Promise<void> {}
  async sendRealtime(): Promise<void> {}
  async sendActivityStart(): Promise<void> {}
  async sendActivityEnd(): Promise<void> {}

  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    yield* this.queue;
  }

  async close(): Promise<void> {}
}

class FakeLiveLlm extends BaseLlm {
  constructor(
    private readonly responses: LlmResponse[] = [],
    private readonly onConnect: () => void = () => {},
  ) {
    super({model: 'fake-live-llm'});
  }

  override generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    throw new Error('generateContentAsync is not used in live tests');
  }

  override async connect(): Promise<BaseLlmConnection> {
    this.onConnect();
    return new FakeLiveConnection(this.responses);
  }
}

async function runLive(agent: BaseAgent): Promise<Event[]> {
  const sessionService = new InMemorySessionService();
  await sessionService.createSession({
    appName: LIVE_APP_NAME,
    userId: LIVE_USER_ID,
    sessionId: LIVE_SESSION_ID,
  });
  const runner = new Runner({
    appName: LIVE_APP_NAME,
    agent,
    sessionService,
  });
  const liveRequestQueue = new LiveRequestQueue();
  liveRequestQueue.close();

  const events: Event[] = [];
  for await (const event of runner.runLive({
    userId: LIVE_USER_ID,
    sessionId: LIVE_SESSION_ID,
    liveRequestQueue,
  })) {
    events.push(event);
  }
  return events;
}

function resolveInstruction(
  agent: LlmAgent,
): Promise<{instruction: string; requireStateInjection: boolean}> {
  return agent.canonicalInstruction(new ReadonlyContext(makeContext(agent)));
}

function resolveTools(agent: LlmAgent): Promise<BaseTool[]> {
  return agent.canonicalTools(new ReadonlyContext(makeContext(agent)));
}

describe('SequentialAgent live task_completed injection', () => {
  it('keeps an async instruction provider callable', async () => {
    const writer = new LlmAgent({
      name: 'writer',
      model: new FakeLiveLlm(),
      instruction: async () => 'BASE',
    });
    const seq = new SequentialAgent({name: 'pipeline', subAgents: [writer]});

    await runLive(seq);

    expect(typeof writer.instruction).toBe('function');
    expect(await resolveInstruction(writer)).toEqual({
      instruction: `BASE${TASK_COMPLETED_SUFFIX}`,
      requireStateInjection: false,
    });
  });

  it('awaits a synchronous instruction provider', async () => {
    const writer = new LlmAgent({
      name: 'writer',
      model: new FakeLiveLlm(),
      instruction: () => 'BASE',
    });
    const seq = new SequentialAgent({name: 'pipeline', subAgents: [writer]});

    await runLive(seq);

    expect(typeof writer.instruction).toBe('function');
    expect(await resolveInstruction(writer)).toEqual({
      instruction: `BASE${TASK_COMPLETED_SUFFIX}`,
      requireStateInjection: false,
    });
  });

  it('concatenates onto a string instruction', async () => {
    const writer = new LlmAgent({
      name: 'writer',
      model: new FakeLiveLlm(),
      instruction: 'BASE',
    });
    const seq = new SequentialAgent({name: 'pipeline', subAgents: [writer]});

    await runLive(seq);

    expect(writer.instruction).toBe(`BASE${TASK_COMPLETED_SUFFIX}`);
    expect(await resolveInstruction(writer)).toEqual({
      instruction: `BASE${TASK_COMPLETED_SUFFIX}`,
      requireStateInjection: true,
    });
  });

  it('propagates an error thrown by the original provider', async () => {
    const writer = new LlmAgent({
      name: 'writer',
      model: new FakeLiveLlm(),
      instruction: () => {
        throw new Error('provider failed');
      },
    });
    const seq = new SequentialAgent({name: 'pipeline', subAgents: [writer]});

    await expect(runLive(seq)).rejects.toThrow('provider failed');
    expect(typeof writer.instruction).toBe('function');
  });

  it('appends the suffix once across repeated live runs', async () => {
    const stringAgent = new LlmAgent({
      name: 'string_agent',
      model: new FakeLiveLlm(),
      instruction: 'BASE',
    });
    const providerAgent = new LlmAgent({
      name: 'provider_agent',
      model: new FakeLiveLlm(),
      instruction: async () => 'BASE',
    });
    const seq = new SequentialAgent({
      name: 'pipeline',
      subAgents: [stringAgent, providerAgent],
    });

    await runLive(seq);
    await runLive(seq);

    for (const agent of [stringAgent, providerAgent]) {
      const tools = await resolveTools(agent);
      const taskCompletedTools = tools.filter(
        (tool) => tool.name === 'task_completed',
      );
      expect(taskCompletedTools).toHaveLength(1);

      const {instruction} = await resolveInstruction(agent);
      expect(instruction.split(TASK_COMPLETED_SUFFIX)).toHaveLength(2);
    }
  });

  it('injects a task_completed tool that signals completion', async () => {
    const writer = new LlmAgent({
      name: 'writer',
      model: new FakeLiveLlm(),
      instruction: 'BASE',
    });
    const seq = new SequentialAgent({name: 'pipeline', subAgents: [writer]});

    await runLive(seq);

    const tool = (await resolveTools(writer)).find(
      (candidate) => candidate.name === 'task_completed',
    );
    if (!tool) {
      expect.fail('the task_completed tool was not injected');
    }
    const result = await tool.runAsync({
      args: {},
      toolContext: new Context({invocationContext: makeContext(writer)}),
    });
    expect(result).toBe('Task completion signaled.');
  });

  it('leaves a sub-agent that already declares task_completed alone', async () => {
    const writer = new LlmAgent({
      name: 'writer',
      model: new FakeLiveLlm(),
      instruction: 'BASE',
      tools: [
        new FunctionTool({
          name: 'task_completed',
          description: 'The agent owns its own completion signal.',
          execute: () => 'own signal',
        }),
      ],
    });
    const seq = new SequentialAgent({name: 'pipeline', subAgents: [writer]});

    await runLive(seq);

    expect(writer.instruction).toBe('BASE');
    expect(await resolveTools(writer)).toHaveLength(1);
  });

  it('does not mutate a sub-agent that is not an LlmAgent', async () => {
    const order: string[] = [];
    const mock = new MockSubAgent(
      {
        name: 'mock',
        beforeAgentCallback: () => {
          order.push('mock');
          return undefined;
        },
      },
      [],
    );
    const writer = new LlmAgent({
      name: 'writer',
      model: new FakeLiveLlm(
        [{content: {role: 'model', parts: [{text: 'drafted'}]}}],
        () => order.push('writer'),
      ),
      instruction: 'BASE',
    });
    const seq = new SequentialAgent({
      name: 'pipeline',
      subAgents: [mock, writer],
    });

    const events = await runLive(seq);

    expect('instruction' in mock).toBe(false);
    expect('tools' in mock).toBe(false);
    expect(order).toEqual(['mock', 'writer']);
    expect(events.map((event) => event.author)).toContain('writer');
  });
});
