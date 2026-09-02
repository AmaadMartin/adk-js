/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveStreamingTool,
  BaseTool,
  FunctionTool,
  InvocationContext,
  LiveRequestQueue,
  LlmAgent,
  LlmRequest,
  PluginManager,
  Task,
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
  runConfigForNewLiveSession,
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
  });

  it('leaves the registry alone when every task has already finished', async () => {
    const invocationContext = makeContext();
    const task = new Task<void>(async () => {});
    await task.promise;
    const streamer = new ActiveStreamingTool({task});
    invocationContext.activeStreamingTools = {streamer};

    await stopBackgroundToolTasks(invocationContext);

    expect(invocationContext.activeStreamingTools).toEqual({streamer});
  });

  it('cancels a cooperative task and empties the registry', async () => {
    const invocationContext = makeContext();
    const streamingTask = cooperativeTask();
    invocationContext.activeStreamingTools = {
      streamer: new ActiveStreamingTool({
        task: streamingTask,
        stream: new LiveRequestQueue(),
      }),
    };

    await stopBackgroundToolTasks(invocationContext);

    expect(streamingTask.done()).toBe(true);
    expect(invocationContext.activeStreamingTools).toEqual({});
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
    invocationContext.activeStreamingTools = {
      stubborn: new ActiveStreamingTool({task: stubbornTask()}),
    };

    const stopped = stopBackgroundToolTasks(invocationContext);
    await vi.advanceTimersByTimeAsync(1000);
    await stopped;

    expect(warn).toHaveBeenCalledWith(
      "Tool task 'stubborn' ignored cancellation and outlives its agent.",
    );
    expect(invocationContext.activeStreamingTools).toEqual({});
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

    expect(declarationsOf(llmRequest)[0].behavior).toBe(Behavior.NON_BLOCKING);
  });

  it('marks a tool that declares a response scheduling', () => {
    const llmRequest = makeLlmRequest(['scheduled'], {
      scheduled: new SchedulingTool(),
    });

    markLiveAsyncToolsNonBlocking(llmRequest);

    expect(declarationsOf(llmRequest)[0].behavior).toBe(Behavior.NON_BLOCKING);
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

describe('runConfigForNewLiveSession', () => {
  it('drops the handle and keeps the rest of the resumption config', () => {
    const runConfig = {
      saveLiveBlob: true,
      sessionResumption: {handle: 'stored', transparent: false},
    };

    expect(runConfigForNewLiveSession(runConfig)).toEqual({
      saveLiveBlob: true,
      sessionResumption: {transparent: false},
    });
  });

  it('leaves the caller config untouched', () => {
    const sessionResumption = {handle: 'stored'};
    const runConfig = {sessionResumption};

    runConfigForNewLiveSession(runConfig);

    expect(sessionResumption).toEqual({handle: 'stored'});
  });

  it('returns the config unchanged when it carries no resumption config', () => {
    const runConfig = {saveLiveBlob: true};

    expect(runConfigForNewLiveSession(runConfig)).toBe(runConfig);
  });

  it('returns undefined when there is no run config', () => {
    expect(runConfigForNewLiveSession(undefined)).toBeUndefined();
  });
});
