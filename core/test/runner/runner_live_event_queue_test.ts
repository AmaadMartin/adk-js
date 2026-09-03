/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Code running underneath a live agent — a node tool, a streaming tool — cannot
 * yield through the agent's own stream, so it pushes onto
 * `InvocationContext.eventQueue`. Live mode never provisioned that queue, so
 * those pushes threw. These tests pin the queue's lifetime and the events it
 * carries.
 */

import {Content, FunctionDeclaration} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LiveRequestQueue} from '../../src/agents/live_request_queue.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {createEvent, Event} from '../../src/events/event.js';
import {BaseLlm} from '../../src/models/base_llm.js';
import {BaseLlmConnection} from '../../src/models/base_llm_connection.js';
import {LlmRequest} from '../../src/models/llm_request.js';
import {LlmResponse} from '../../src/models/llm_response.js';
import {BasePlugin} from '../../src/plugins/base_plugin.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {BaseTool, RunAsyncToolRequest} from '../../src/tools/base_tool.js';
import {AsyncQueue} from '../../src/utils/async_queue.js';

const APP_NAME = 'live_queue_app';
const USER_ID = 'u';
const SESSION_ID = 's';

/** Options for {@link ScriptedLiveLlm}. */
interface ScriptedLiveLlmOptions {
  /**
   * Keep the connection open once the script is exhausted, so the live root
   * stays waiting in `receive()` instead of finishing.
   */
  stayOpen?: boolean;
}

/** A live connection that replays a fixed script and then ends. */
class ScriptedConnection implements BaseLlmConnection {
  closed = false;
  private readonly queue = new AsyncQueue<LlmResponse | Error>();

  constructor(responses: Array<LlmResponse | Error>, stayOpen = false) {
    for (const response of responses) {
      this.queue.push(response);
    }
    if (!stayOpen) {
      this.queue.close();
    }
  }

  async sendHistory(): Promise<void> {}
  async sendContent(): Promise<void> {}
  async sendRealtime(): Promise<void> {}
  async sendActivityStart(): Promise<void> {}
  async sendActivityEnd(): Promise<void> {}
  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    for await (const response of this.queue) {
      if (response instanceof Error) {
        throw response;
      }
      yield response;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.queue.close();
  }
}

class ScriptedLiveLlm extends BaseLlm {
  constructor(
    private readonly responses: Array<LlmResponse | Error>,
    private readonly options: ScriptedLiveLlmOptions = {},
  ) {
    super({model: 'scripted-live-llm'});
  }

  override generateContentAsync(): AsyncGenerator<LlmResponse, void, void> {
    throw new Error('generateContentAsync is not used by a live test');
  }

  override async connect(_: LlmRequest): Promise<BaseLlmConnection> {
    return new ScriptedConnection(this.responses, this.options.stayOpen);
  }
}

/** Pushes its own events onto the invocation's event queue, as a node tool does. */
class QueueEmittingTool extends BaseTool {
  seenQueue?: AsyncQueue<Event>;

  constructor(private readonly emitted: Event[]) {
    super({name: 'emitter', description: 'Emits events onto the event queue.'});
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return {name: this.name, description: this.description};
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const ic: InvocationContext = request.toolContext.invocationContext;
    if (!ic.eventQueue) {
      throw new Error(`Tool '${this.name}' requires an invocation event queue`);
    }
    this.seenQueue = ic.eventQueue;
    for (const event of this.emitted) {
      ic.eventQueue.push(event);
    }
    return {ok: true};
  }
}

/**
 * Pushes an event onto the queue and then blocks, so the root stays mid-`next()`
 * while the caller receives that event. This is the shape a streaming tool has:
 * it reports progress before it has a result.
 */
class BlockingEmittingTool extends BaseTool {
  private release?: () => void;
  readonly blocked = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor(private readonly emitted: Event) {
    super({name: 'emitter', description: 'Emits, then blocks.'});
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return {name: this.name, description: this.description};
  }

  /** Lets the tool finish, so the live root can produce again. */
  unblock(): void {
    this.release!();
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const ic: InvocationContext = request.toolContext.invocationContext;
    if (!ic.eventQueue) {
      throw new Error(`Tool '${this.name}' requires an invocation event queue`);
    }
    ic.eventQueue.push(this.emitted);
    await this.blocked;
    return {ok: true};
  }
}

/** Captures the invocation context the runner built, and the queue it held. */
class ContextCapturingPlugin extends BasePlugin {
  context?: InvocationContext;
  seenQueue?: AsyncQueue<Event>;

  constructor() {
    super('context-capturing');
  }

  override async beforeRunCallback(params: {
    invocationContext: InvocationContext;
  }): Promise<Content | undefined> {
    this.context = params.invocationContext;
    return undefined;
  }

  override async onEventCallback(params: {
    invocationContext: InvocationContext;
    event: Event;
  }): Promise<Event | undefined> {
    this.seenQueue ??= params.invocationContext.eventQueue;
    return undefined;
  }
}

const TOOL_CALL: Content = {
  role: 'model',
  parts: [{functionCall: {id: 'call-1', name: 'emitter', args: {}}}],
};

function queuedEvent(text: string, partial?: boolean): Event {
  return createEvent({
    author: 'emitter',
    content: {role: 'model', parts: [{text}]},
    partial,
  });
}

async function runLiveToCompletion(
  runner: Runner,
): Promise<{events: Event[]; queue: LiveRequestQueue}> {
  const queue = new LiveRequestQueue();
  const events: Event[] = [];
  for await (const event of runner.runLive({
    userId: USER_ID,
    sessionId: SESSION_ID,
    liveRequestQueue: queue,
  })) {
    events.push(event);
  }
  return {events, queue};
}

describe('Runner.runLive event queue', () => {
  let sessionService: InMemorySessionService;

  beforeEach(async () => {
    sessionService = new InMemorySessionService();
    await sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
  });

  it('surfaces the events a tool pushes onto the queue', async () => {
    const tool = new QueueEmittingTool([queuedEvent('from the tool')]);
    const agent = new LlmAgent({
      name: 'host',
      model: new ScriptedLiveLlm([{content: TOOL_CALL} as LlmResponse]),
      tools: [tool],
    });
    const runner = new Runner({appName: APP_NAME, agent, sessionService});

    const {events} = await runLiveToCompletion(runner);

    expect(events.map((e) => e.content?.parts?.[0]?.text)).toContain(
      'from the tool',
    );
  });

  it('carries the tool events and the agent events in one stream', async () => {
    const tool = new QueueEmittingTool([
      queuedEvent('step one'),
      queuedEvent('step two'),
    ]);
    const agent = new LlmAgent({
      name: 'host',
      model: new ScriptedLiveLlm([{content: TOOL_CALL} as LlmResponse]),
      tools: [tool],
    });
    const runner = new Runner({appName: APP_NAME, agent, sessionService});

    const {events} = await runLiveToCompletion(runner);
    const texts = events
      .map((e) => e.content?.parts?.[0]?.text)
      .filter((t) => t !== undefined);

    expect(texts.indexOf('step one')).toBeLessThan(texts.indexOf('step two'));
  });

  it('appends a non-partial queued event to the session but not a partial one', async () => {
    const tool = new QueueEmittingTool([
      queuedEvent('persisted'),
      queuedEvent('streaming', true),
    ]);
    const agent = new LlmAgent({
      name: 'host',
      model: new ScriptedLiveLlm([{content: TOOL_CALL} as LlmResponse]),
      tools: [tool],
    });
    const runner = new Runner({appName: APP_NAME, agent, sessionService});

    const {events} = await runLiveToCompletion(runner);
    const stored = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const storedTexts = stored!.events.map((e) => e.content?.parts?.[0]?.text);

    expect(events.map((e) => e.content?.parts?.[0]?.text)).toContain(
      'streaming',
    );
    expect(storedTexts).toContain('persisted');
    expect(storedTexts).not.toContain('streaming');
  });

  it('persists and yields the onEvent callback rewrite of a queued event', async () => {
    class RewritingPlugin extends BasePlugin {
      constructor() {
        super('rewriting');
      }
      override async onEventCallback(params: {
        invocationContext: InvocationContext;
        event: Event;
      }): Promise<Event | undefined> {
        if (params.event.content?.parts?.[0]?.text !== 'original') {
          return undefined;
        }
        return createEvent({
          ...params.event,
          content: {role: 'model', parts: [{text: 'rewritten'}]},
        });
      }
    }

    const tool = new QueueEmittingTool([queuedEvent('original')]);
    const agent = new LlmAgent({
      name: 'host',
      model: new ScriptedLiveLlm([{content: TOOL_CALL} as LlmResponse]),
      tools: [tool],
    });
    const runner = new Runner({
      appName: APP_NAME,
      agent,
      sessionService,
      plugins: [new RewritingPlugin()],
    });

    const {events} = await runLiveToCompletion(runner);
    const stored = await sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    expect(events.map((e) => e.content?.parts?.[0]?.text)).toContain(
      'rewritten',
    );
    expect(stored!.events.map((e) => e.content?.parts?.[0]?.text)).toContain(
      'rewritten',
    );
    expect(events.map((e) => e.content?.parts?.[0]?.text)).not.toContain(
      'original',
    );
  });

  it('hands the tool the queue the run was started with', async () => {
    const capture = new ContextCapturingPlugin();
    const tool = new QueueEmittingTool([queuedEvent('done')]);
    const agent = new LlmAgent({
      name: 'host',
      model: new ScriptedLiveLlm([{content: TOOL_CALL} as LlmResponse]),
      tools: [tool],
    });
    const runner = new Runner({
      appName: APP_NAME,
      agent,
      sessionService,
      plugins: [capture],
    });

    await runLiveToCompletion(runner);

    expect(tool.seenQueue).toBeDefined();
    expect(capture.seenQueue).toBe(tool.seenQueue);
  });

  it('clears the queue from the context once the run has finished', async () => {
    const capture = new ContextCapturingPlugin();
    const tool = new QueueEmittingTool([queuedEvent('done')]);
    const agent = new LlmAgent({
      name: 'host',
      model: new ScriptedLiveLlm([{content: TOOL_CALL} as LlmResponse]),
      tools: [tool],
    });
    const runner = new Runner({
      appName: APP_NAME,
      agent,
      sessionService,
      plugins: [capture],
    });

    await runLiveToCompletion(runner);

    expect(capture.context!.eventQueue).toBeUndefined();
  });

  it('clears the queue from the context when the run fails', async () => {
    const capture = new ContextCapturingPlugin();
    const tool = new QueueEmittingTool([queuedEvent('before the failure')]);
    const agent = new LlmAgent({
      name: 'host',
      model: new ScriptedLiveLlm([
        {content: TOOL_CALL} as LlmResponse,
        new Error('live connection failed'),
      ]),
      tools: [tool],
    });
    const runner = new Runner({
      appName: APP_NAME,
      agent,
      sessionService,
      plugins: [capture],
    });

    await expect(runLiveToCompletion(runner)).rejects.toThrow(
      'live connection failed',
    );

    expect(capture.seenQueue).toBeDefined();
    expect(capture.context!.eventQueue).toBeUndefined();
  });

  it('returns to a caller that stops on a queued event while the model is quiet', async () => {
    const capture = new ContextCapturingPlugin();
    const tool = new BlockingEmittingTool(queuedEvent('tool progress'));
    const agent = new LlmAgent({
      name: 'host',
      // The connection stays open after the tool call and produces nothing
      // more, so the live root sits in `connection.receive()`.
      model: new ScriptedLiveLlm([{content: TOOL_CALL} as LlmResponse], {
        stayOpen: true,
      }),
      tools: [tool],
    });
    const runner = new Runner({
      appName: APP_NAME,
      agent,
      sessionService,
      plugins: [capture],
    });

    const controller = new AbortController();
    const seen: Event[] = [];
    for await (const event of runner.runLive({
      userId: USER_ID,
      sessionId: SESSION_ID,
      liveRequestQueue: new LiveRequestQueue(),
      abortSignal: controller.signal,
    })) {
      seen.push(event);
      if (event.content?.parts?.[0]?.text === 'tool progress') {
        controller.abort();
        break;
      }
    }

    // Reaching here at all is the assertion: before the teardown fix the loop
    // above never returned, because the stop request sat behind the live root's
    // pending pull.
    expect(seen.map((e) => e.content?.parts?.[0]?.text)).toContain(
      'tool progress',
    );
    expect(capture.context!.eventQueue).toBeUndefined();

    tool.unblock();
  });
});
