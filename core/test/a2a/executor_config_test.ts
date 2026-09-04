/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart, TaskArtifactUpdateEvent, TextPart} from '@a2a-js/sdk';
import {ExecutionEventBus, RequestContext} from '@a2a-js/sdk/server';
import {
  A2A_AGENT_EXECUTOR_CONFIG_DEFAULTS,
  A2AAgentExecutor,
  A2aAgentExecutorConverterConfig,
  Event as AdkEvent,
  AdkEventToA2AEventsConverter,
  AdkEventToA2AEventsConverterImpl,
  BaseSessionService,
  createEvent,
  createEventActions,
  ExecutorContext,
  GenAIPartToA2APartConverter,
  resolveA2aAgentExecutorConfig,
  Runner,
  RunnerConfig,
  Session,
  toA2AArtifactUpdateEvents,
  toA2AArtifactUpdateEventsFromArtifactMap,
} from '@google/adk';
import {beforeEach, describe, expect, it, Mocked, vi} from 'vitest';

vi.mock('../../src/runner/runner.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/runner/runner.js')>();
  return {
    ...actual,
    Runner: vi.fn().mockImplementation((config: RunnerConfig) => ({
      appName: config?.appName,
      sessionService: config?.sessionService,
      runAsync: vi.fn(),
    })),
  };
});

const TASK_ID = 'task-1';
const CONTEXT_ID = 'context-1';

const modelEvent = (
  text: string,
  partial = false,
  author = 'model',
): AdkEvent =>
  createEvent({
    author,
    content: {role: 'model', parts: [{text}]},
    partial,
    actions: createEventActions(),
  });

const {
  a2aPartConverter: defaultA2aPartConverter,
  genAiPartConverter: defaultGenAiPartConverter,
} = A2A_AGENT_EXECUTOR_CONFIG_DEFAULTS;

const noopEventConverter: AdkEventToA2AEventsConverter = () => [];
const noopAdkEventConverter: AdkEventToA2AEventsConverterImpl = () => [];

describe('resolveA2aAgentExecutorConfig', () => {
  it('fills every slot from the declared defaults', () => {
    const resolved = resolveA2aAgentExecutorConfig({});

    expect(resolved.a2aPartConverter).toBe(defaultA2aPartConverter);
    expect(resolved.genAiPartConverter).toBe(defaultGenAiPartConverter);
    expect(resolved.eventConverter).toBeUndefined();
    expect(resolved.adkEventConverter).toBe(
      toA2AArtifactUpdateEventsFromArtifactMap,
    );
    expect(resolved).toEqual({...A2A_AGENT_EXECUTOR_CONFIG_DEFAULTS});
  });

  it('keeps every supplied converter', () => {
    const a2aPartConverter = vi.fn(defaultA2aPartConverter);
    const genAiPartConverter = vi.fn(defaultGenAiPartConverter);

    const resolved = resolveA2aAgentExecutorConfig({
      a2aPartConverter,
      genAiPartConverter,
      eventConverter: noopEventConverter,
      adkEventConverter: noopAdkEventConverter,
    });

    expect(resolved.a2aPartConverter).toBe(a2aPartConverter);
    expect(resolved.genAiPartConverter).toBe(genAiPartConverter);
    expect(resolved.eventConverter).toBe(noopEventConverter);
    expect(resolved.adkEventConverter).toBe(noopAdkEventConverter);
  });

  it('treats an explicit undefined as unset', () => {
    const resolved = resolveA2aAgentExecutorConfig({
      a2aPartConverter: undefined,
      genAiPartConverter: undefined,
      eventConverter: undefined,
      adkEventConverter: undefined,
    });

    expect(resolved).toEqual({...A2A_AGENT_EXECUTOR_CONFIG_DEFAULTS});
  });

  it('does not mutate the config it was given', () => {
    const config: A2aAgentExecutorConverterConfig = {};

    resolveA2aAgentExecutorConfig(config);

    expect(config).toEqual({});
  });

  it.each([
    ['a2aPartConverter', 3, 'number'],
    ['genAiPartConverter', 'nope', 'string'],
    ['eventConverter', null, 'null'],
    ['adkEventConverter', {}, 'object'],
  ])('rejects a %s that is a %s', (field, value, described) => {
    expect(() =>
      resolveA2aAgentExecutorConfig({
        [field]: value,
      } as A2aAgentExecutorConverterConfig),
    ).toThrow(
      `A2A executor config field "${field}" must be a function, received ${described}`,
    );
  });

  it('reports the first offending field in source order', () => {
    expect(() =>
      resolveA2aAgentExecutorConfig({
        genAiPartConverter: 1,
        adkEventConverter: 2,
      } as unknown as A2aAgentExecutorConverterConfig),
    ).toThrow(
      'A2A executor config field "genAiPartConverter" must be a function, received number',
    );
  });
});

describe('toA2AArtifactUpdateEventsFromArtifactMap', () => {
  it('publishes nothing for an event with no parts', () => {
    const events = toA2AArtifactUpdateEventsFromArtifactMap(
      createEvent({author: 'model', actions: createEventActions()}),
      new Map(),
      TASK_ID,
      CONTEXT_ID,
      defaultGenAiPartConverter,
    );

    expect(events).toEqual([]);
  });

  it('reuses one artifact id across the chunks of one response', () => {
    const agentsArtifacts = new Map<string, string>();

    const [first] = toA2AArtifactUpdateEventsFromArtifactMap(
      modelEvent('chunk 1', true),
      agentsArtifacts,
      TASK_ID,
      CONTEXT_ID,
      defaultGenAiPartConverter,
    ) as TaskArtifactUpdateEvent[];
    const [last] = toA2AArtifactUpdateEventsFromArtifactMap(
      modelEvent('chunk 2'),
      agentsArtifacts,
      TASK_ID,
      CONTEXT_ID,
      defaultGenAiPartConverter,
    ) as TaskArtifactUpdateEvent[];

    expect(first.artifact.artifactId).toBe(last.artifact.artifactId);
    expect(first.append).toBe(true);
    expect(last.lastChunk).toBe(true);
    expect(agentsArtifacts.size).toBe(0);
  });

  it('keeps one artifact id per author', () => {
    const agentsArtifacts = new Map<string, string>();

    toA2AArtifactUpdateEventsFromArtifactMap(
      modelEvent('a', true, 'writer'),
      agentsArtifacts,
      TASK_ID,
      CONTEXT_ID,
      defaultGenAiPartConverter,
    );
    toA2AArtifactUpdateEventsFromArtifactMap(
      modelEvent('b', true, 'reviewer'),
      agentsArtifacts,
      TASK_ID,
      CONTEXT_ID,
      defaultGenAiPartConverter,
    );

    expect(agentsArtifacts.get('writer')).not.toBe(
      agentsArtifacts.get('reviewer'),
    );
  });

  it('converts each part with the supplied converter', () => {
    const genAiPartConverter: GenAIPartToA2APartConverter = vi.fn(
      (): A2APart => ({kind: 'text', text: 'rewritten'}),
    );

    const [event] = toA2AArtifactUpdateEventsFromArtifactMap(
      modelEvent('original'),
      new Map(),
      TASK_ID,
      CONTEXT_ID,
      genAiPartConverter,
    ) as TaskArtifactUpdateEvent[];

    expect((event.artifact.parts[0] as TextPart).text).toBe('rewritten');
    expect(genAiPartConverter).toHaveBeenCalledTimes(1);
  });

  it('falls back to toA2APart when no converter is supplied', () => {
    const [event] = toA2AArtifactUpdateEventsFromArtifactMap(
      modelEvent('original'),
      new Map(),
      TASK_ID,
      CONTEXT_ID,
    ) as TaskArtifactUpdateEvent[];

    expect((event.artifact.parts[0] as TextPart).text).toBe('original');
  });

  it('rejects an undefined artifact map, as adk-python rejects None', () => {
    expect(() =>
      toA2AArtifactUpdateEventsFromArtifactMap(
        modelEvent('original'),
        undefined,
        TASK_ID,
        CONTEXT_ID,
        defaultGenAiPartConverter,
      ),
    ).toThrow('A2A executor artifact map cannot be undefined');
  });
});

describe('toA2AArtifactUpdateEvents', () => {
  const executorContextFor = (sessionId: string): ExecutorContext => ({
    userId: 'user',
    sessionId,
    appName: 'app',
    readonlyState: {},
    events: [],
    userContent: {role: 'user', parts: [{text: 'hi'}]},
    requestContext: {
      taskId: TASK_ID,
      contextId: CONTEXT_ID,
    } as unknown as RequestContext,
  });

  it('reuses one artifact id across the chunks of one execution', () => {
    const executorContext = executorContextFor('session-1');

    const [first] = toA2AArtifactUpdateEvents(
      modelEvent('chunk 1', true),
      executorContext,
      TASK_ID,
      CONTEXT_ID,
      defaultGenAiPartConverter,
    ) as TaskArtifactUpdateEvent[];
    const [second] = toA2AArtifactUpdateEvents(
      modelEvent('chunk 2', true),
      executorContext,
      TASK_ID,
      CONTEXT_ID,
      defaultGenAiPartConverter,
    ) as TaskArtifactUpdateEvent[];

    expect(first.artifact.artifactId).toBe(second.artifact.artifactId);
  });

  it('keeps two executions apart', () => {
    const [first] = toA2AArtifactUpdateEvents(
      modelEvent('chunk 1', true),
      executorContextFor('session-1'),
      TASK_ID,
      CONTEXT_ID,
      defaultGenAiPartConverter,
    ) as TaskArtifactUpdateEvent[];
    const [second] = toA2AArtifactUpdateEvents(
      modelEvent('chunk 1', true),
      executorContextFor('session-2'),
      TASK_ID,
      CONTEXT_ID,
    ) as TaskArtifactUpdateEvent[];

    expect(first.artifact.artifactId).not.toBe(second.artifact.artifactId);
  });
});

describe('A2AAgentExecutor converter routing', () => {
  let mockSessionService: Mocked<BaseSessionService>;
  let mockEventBus: Mocked<ExecutionEventBus>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSessionService = {
      getSession: vi.fn(),
      createSession: vi.fn(),
      getOrCreateSession: vi.fn(),
      listSessions: vi.fn(),
      deleteSession: vi.fn(),
      appendEvent: vi.fn(),
    } as unknown as Mocked<BaseSessionService>;

    mockEventBus = {publish: vi.fn()} as unknown as Mocked<ExecutionEventBus>;

    mockSessionService.getSession.mockResolvedValue({
      id: 'session-id',
      userId: 'test-user',
      appName: 'test-app',
      events: [],
      state: {},
    } as unknown as Session);
  });

  const runnerConfig = () =>
    ({
      appName: 'test-app',
      sessionService: mockSessionService,
    }) as unknown as RunnerConfig;

  const requestContext = (contextId: string): RequestContext =>
    ({
      contextId,
      taskId: `task-${contextId}`,
      userMessage: {role: 'user', parts: [{kind: 'text', text: 'hello'}]},
    }) as unknown as RequestContext;

  /** Yields its events, pausing between them so two runs interleave. */
  const stubRunnerWithGate = (gate: () => Promise<void>) => {
    vi.mocked(Runner).mockImplementation(
      ((config: RunnerConfig) =>
        ({
          appName: config?.appName,
          sessionService: config?.sessionService,
          async *runAsync({sessionId}: {sessionId: string}) {
            yield modelEvent(`${sessionId} chunk 1`, true);
            await gate();
            yield modelEvent(`${sessionId} chunk 2`);
          },
        }) as unknown as Runner) as unknown as () => Runner,
    );
  };

  it('runs the impl converter when only adkEventConverter is set', async () => {
    stubRunnerWithGate(async () => {});
    const adkEventConverter: AdkEventToA2AEventsConverterImpl = vi.fn(() => []);

    const executor = new A2AAgentExecutor({
      runner: runnerConfig(),
      adkEventConverter,
    });
    await executor.execute(requestContext('a'), mockEventBus);

    expect(adkEventConverter).toHaveBeenCalledTimes(2);
  });

  it('lets eventConverter win over adkEventConverter', async () => {
    stubRunnerWithGate(async () => {});
    const eventConverter: AdkEventToA2AEventsConverter = vi.fn(() => []);
    const adkEventConverter: AdkEventToA2AEventsConverterImpl = vi.fn(() => []);

    const executor = new A2AAgentExecutor({
      runner: runnerConfig(),
      eventConverter,
      adkEventConverter,
    });
    await executor.execute(requestContext('a'), mockEventBus);

    expect(eventConverter).toHaveBeenCalledTimes(2);
    expect(adkEventConverter).not.toHaveBeenCalled();
  });

  it('converts the inbound message with the configured a2aPartConverter', async () => {
    stubRunnerWithGate(async () => {});
    const a2aPartConverter = vi.fn(defaultA2aPartConverter);

    const executor = new A2AAgentExecutor({
      runner: runnerConfig(),
      a2aPartConverter,
    });
    await executor.execute(requestContext('a'), mockEventBus);

    expect(a2aPartConverter).toHaveBeenCalledWith({
      kind: 'text',
      text: 'hello',
    });
  });

  it('rejects a converter that is not a function when it is constructed', () => {
    expect(
      () =>
        new A2AAgentExecutor({
          runner: runnerConfig(),
          genAiPartConverter: 'nope' as unknown as GenAIPartToA2APartConverter,
        }),
    ).toThrow(
      'A2A executor config field "genAiPartConverter" must be a function, received string',
    );
  });

  it('keeps two concurrent executions on separate artifacts', async () => {
    let releaseFirst = () => {};
    const firstReachedGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let started = 0;
    stubRunnerWithGate(async () => {
      started++;
      if (started === 1) {
        await firstReachedGate;
      } else {
        releaseFirst();
      }
    });

    const executor = new A2AAgentExecutor({runner: runnerConfig()});
    await Promise.all([
      executor.execute(requestContext('a'), mockEventBus),
      executor.execute(requestContext('b'), mockEventBus),
    ]);

    const byTask = new Map<string, Set<string>>();
    for (const [event] of mockEventBus.publish.mock.calls) {
      if (event.kind !== 'artifact-update') {
        continue;
      }
      const ids = byTask.get(event.taskId) ?? new Set<string>();
      ids.add(event.artifact.artifactId);
      byTask.set(event.taskId, ids);
    }

    expect([...byTask.keys()].sort()).toEqual(['task-a', 'task-b']);
    for (const ids of byTask.values()) {
      expect(ids.size).toBe(1);
    }
    const allIds = [...byTask.values()].flatMap((ids) => [...ids]);
    expect(new Set(allIds).size).toBe(2);
  });
});
