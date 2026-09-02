/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveStreamingTool,
  AsyncQueue,
  BaseTool,
  Event,
  FunctionTool,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  PluginManager,
  Task,
  createEvent,
  createSession,
} from '@google/adk';
import {
  Behavior,
  FunctionDeclaration,
  FunctionResponseScheduling,
} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

import {
  markLiveAsyncToolsNonBlocking,
  mergeEventStreams,
  stopBackgroundToolTasks,
} from '../../src/agents/live_flow_utils.js';
import {logger} from '../../src/utils/logger.js';

function makeContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'invocation-id',
    agent: new LlmAgent({name: 'agent', model: 'fake-model'}),
    session: createSession({id: 'session-id', appName: 'app', userId: 'user'}),
    pluginManager: new PluginManager(),
  });
}

/** A task that resolves as soon as its abort signal fires. */
function cooperativeTask(): Task<void> {
  return new Task<void>(
    (abortSignal) =>
      new Promise<void>((resolve) => {
        abortSignal.addEventListener('abort', () => resolve(), {once: true});
      }),
  );
}

/** A task that never resolves, so cancellation cannot stop it. */
function stubbornTask(): Task<void> {
  return new Task<void>(() => new Promise<void>(() => {}));
}

describe('stopBackgroundToolTasks', () => {
  it('does nothing when the invocation started no tasks', async () => {
    const invocationContext = makeContext();

    await stopBackgroundToolTasks(invocationContext);

    expect(invocationContext.activeStreamingTools).toBeUndefined();
    expect(invocationContext.activeNonBlockingToolTasks).toBeUndefined();
  });

  it('leaves a registry alone when every task has already finished', async () => {
    const invocationContext = makeContext();
    const task = new Task<void>(async () => {});
    await task.promise;
    invocationContext.activeNonBlockingToolTasks = {done: task};

    await stopBackgroundToolTasks(invocationContext);

    expect(invocationContext.activeNonBlockingToolTasks).toEqual({done: task});
  });

  it('cancels a cooperative task and empties both registries', async () => {
    const invocationContext = makeContext();
    const streamingTask = cooperativeTask();
    const nonBlockingTask = cooperativeTask();
    invocationContext.activeStreamingTools = {
      streamer: new ActiveStreamingTool({
        task: streamingTask,
        stream: new LiveRequestQueue(),
      }),
    };
    invocationContext.activeNonBlockingToolTasks = {
      worker: nonBlockingTask,
    };

    await stopBackgroundToolTasks(invocationContext);

    expect(streamingTask.done()).toBe(true);
    expect(nonBlockingTask.done()).toBe(true);
    expect(invocationContext.activeStreamingTools).toEqual({});
    expect(invocationContext.activeNonBlockingToolTasks).toEqual({});
  });

  it('skips a streaming tool that registered no task', async () => {
    const invocationContext = makeContext();
    const task = cooperativeTask();
    invocationContext.activeStreamingTools = {
      streamOnly: new ActiveStreamingTool({stream: new LiveRequestQueue()}),
      streamer: new ActiveStreamingTool({task}),
    };

    await stopBackgroundToolTasks(invocationContext);

    expect(task.done()).toBe(true);
    expect(invocationContext.activeStreamingTools).toEqual({});
  });

  it('warns about a task that ignores cancellation and still drops it', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const invocationContext = makeContext();
    invocationContext.activeNonBlockingToolTasks = {stubborn: stubbornTask()};

    const stopped = stopBackgroundToolTasks(invocationContext);
    await vi.advanceTimersByTimeAsync(1000);
    await stopped;

    expect(warn).toHaveBeenCalledWith(
      "Tool task 'stubborn' ignored cancellation and outlives its agent.",
    );
    expect(invocationContext.activeNonBlockingToolTasks).toEqual({});
    warn.mockRestore();
    vi.useRealTimers();
  });
});

class SchedulingTool extends BaseTool {
  constructor() {
    super({
      name: 'scheduled',
      description: 'Answers when the model is idle.',
      responseScheduling: FunctionResponseScheduling.WHEN_IDLE,
    });
  }
  override async runAsync(): Promise<unknown> {
    return 'ok';
  }
}

function makeLlmRequest(
  declarationNames: string[],
  toolsDict: Record<string, BaseTool>,
): LlmRequest {
  return {
    contents: [],
    toolsDict,
    liveConnectConfig: {},
    config: {
      tools: [
        {
          functionDeclarations: declarationNames.map((name) => ({name})),
        },
      ],
    },
  };
}

/** The declarations of the request's first tool entry. */
function declarationsOf(llmRequest: LlmRequest): FunctionDeclaration[] {
  const geminiTool = llmRequest.config?.tools?.[0];
  if (!geminiTool || !('functionDeclarations' in geminiTool)) {
    return expect.fail('the request carries no function declarations');
  }
  return geminiTool.functionDeclarations ?? [];
}

describe('markLiveAsyncToolsNonBlocking', () => {
  it('marks a streaming tool NON_BLOCKING', () => {
    const streamingTool = new FunctionTool({
      name: 'streamer',
      description: 'Yields results as they arrive.',
      execute: async function* () {
        yield 'chunk';
      },
    });
    const llmRequest = makeLlmRequest(['streamer'], {streamer: streamingTool});

    markLiveAsyncToolsNonBlocking(llmRequest);

    expect(declarationsOf(llmRequest)[0].behavior).toBe(
      Behavior.NON_BLOCKING,
    );
  });

  it('marks a tool that declares a response scheduling', () => {
    const llmRequest = makeLlmRequest(['scheduled'], {
      scheduled: new SchedulingTool(),
    });

    markLiveAsyncToolsNonBlocking(llmRequest);

    expect(declarationsOf(llmRequest)[0].behavior).toBe(
      Behavior.NON_BLOCKING,
    );
  });

  it('leaves a synchronous tool unmarked', () => {
    const plainTool = new FunctionTool({
      name: 'plain',
      description: 'Answers at once.',
      execute: async () => 'ok',
    });
    const llmRequest = makeLlmRequest(['plain'], {plain: plainTool});

    markLiveAsyncToolsNonBlocking(llmRequest);

    expect(declarationsOf(llmRequest)[0].behavior).toBeUndefined();
  });

  it('skips a declaration with no name and one absent from the tools', () => {
    const llmRequest = makeLlmRequest(['unknown'], {});
    declarationsOf(llmRequest).push({});

    markLiveAsyncToolsNonBlocking(llmRequest);

    for (const declaration of declarationsOf(llmRequest)) {
      expect(declaration.behavior).toBeUndefined();
    }
  });

  it('skips a tool entry that carries no function declarations', () => {
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
      config: {tools: [{googleSearch: {}}, {functionDeclarations: undefined}]},
    };

    expect(() => markLiveAsyncToolsNonBlocking(llmRequest)).not.toThrow();
  });

  it('does nothing when the request declares no tools', () => {
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };

    expect(() => markLiveAsyncToolsNonBlocking(llmRequest)).not.toThrow();
  });
});

async function* eventsOf(
  ...texts: string[]
): AsyncGenerator<Event, void, void> {
  for (const text of texts) {
    yield createEvent({author: 'agent', content: {parts: [{text}]}});
  }
}

function textOf(event: Event): string | undefined {
  return event.content?.parts?.[0].text;
}

describe('mergeEventStreams', () => {
  it('yields the primary stream when nothing is screened', async () => {
    const screened = new AsyncQueue<Event>();
    const merged: string[] = [];

    for await (const event of mergeEventStreams(
      eventsOf('one', 'two'),
      screened,
    )) {
      merged.push(textOf(event)!);
    }

    expect(merged).toEqual(['one', 'two']);
  });

  it('delivers a screened event without waiting for the primary stream', async () => {
    const screened = new AsyncQueue<Event>();
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    async function* slowPrimary(): AsyncGenerator<Event, void, void> {
      await gate;
      yield createEvent({author: 'agent', content: {parts: [{text: 'late'}]}});
    }

    const iterator = mergeEventStreams(slowPrimary(), screened);
    screened.push(
      createEvent({author: 'agent', content: {parts: [{text: 'blocked'}]}}),
    );

    const first = await iterator.next();
    expect(textOf(first.value as Event)).toBe('blocked');

    released();
    const second = await iterator.next();
    expect(textOf(second.value as Event)).toBe('late');
    expect((await iterator.next()).done).toBe(true);
  });

  it('keeps yielding the primary stream after the screened queue closes', async () => {
    const screened = new AsyncQueue<Event>();
    screened.close();
    const merged: string[] = [];

    for await (const event of mergeEventStreams(eventsOf('one'), screened)) {
      merged.push(textOf(event)!);
    }

    expect(merged).toEqual(['one']);
  });

  it('propagates an error the primary stream throws', async () => {
    const screened = new AsyncQueue<Event>();
    async function* failingPrimary(): AsyncGenerator<Event, void, void> {
      yield createEvent({author: 'agent', content: {parts: [{text: 'one'}]}});
      throw new Error('receive loop failed');
    }

    const iterator = mergeEventStreams(failingPrimary(), screened);
    await iterator.next();

    await expect(iterator.next()).rejects.toThrow('receive loop failed');
  });

  it('closes the primary stream when the caller stops early', async () => {
    const screened = new AsyncQueue<Event>();
    let closed = false;
    async function* closablePrimary(): AsyncGenerator<Event, void, void> {
      try {
        yield createEvent({author: 'agent', content: {parts: [{text: 'one'}]}});
        yield createEvent({author: 'agent', content: {parts: [{text: 'two'}]}});
      } finally {
        closed = true;
      }
    }

    for await (const _ of mergeEventStreams(closablePrimary(), screened)) {
      break;
    }
    await vi.waitFor(() => expect(closed).toBe(true));
  });
});
