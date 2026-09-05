/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart, TaskArtifactUpdateEvent, TextPart} from '@a2a-js/sdk';
import {ExecutionEventBus, RequestContext} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  A2aAgentExecutorConverterConfig,
  A2AEvent,
  Event as AdkEvent,
  AdkEventToA2AEventsConverter,
  AdkEventToA2AEventsConverterImpl,
  BaseSessionService,
  createEvent,
  createEventActions,
  createSession,
  GenAIPartToA2APartConverter,
  resolveA2aAgentExecutorConfig,
  Runner,
  RunnerConfig,
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
} = resolveA2aAgentExecutorConfig({});

/** Asserts the converter produced exactly one artifact update, and returns it. */
const onlyArtifactUpdate = (events: A2AEvent[]): TaskArtifactUpdateEvent => {
  const [event] = events;
  if (event?.kind !== 'artifact-update') {
    expect.fail(`expected one artifact update, got ${JSON.stringify(events)}`);
  }
  return event;
};

const noopAdkEventConverter: AdkEventToA2AEventsConverterImpl = () => [];

describe('resolveA2aAgentExecutorConfig', () => {
  it('fills every slot with the default the config declares', () => {
    const resolved = resolveA2aAgentExecutorConfig({});

    expect(resolved.adkEventConverter).toBe(
      toA2AArtifactUpdateEventsFromArtifactMap,
    );
    expect(resolved.a2aPartConverter({kind: 'text', text: 'hi'})).toEqual({
      text: 'hi',
      thought: false,
    });
    expect(resolved.genAiPartConverter({text: 'hi'})).toEqual({
      kind: 'text',
      text: 'hi',
      metadata: undefined,
    });
    expect(Object.keys(resolved).sort()).toEqual([
      'a2aPartConverter',
      'adkEventConverter',
      'eventConverter',
      'genAiPartConverter',
    ]);
  });

  it('carries a supplied eventConverter through, with no default for it', () => {
    const eventConverter: AdkEventToA2AEventsConverter = () => [];

    expect(resolveA2aAgentExecutorConfig({}).eventConverter).toBeUndefined();
    expect(resolveA2aAgentExecutorConfig({eventConverter}).eventConverter).toBe(
      eventConverter,
    );
  });

  it('keeps every supplied converter', () => {
    const a2aPartConverter = vi.fn(defaultA2aPartConverter);
    const genAiPartConverter = vi.fn(defaultGenAiPartConverter);

    const resolved = resolveA2aAgentExecutorConfig({
      a2aPartConverter,
      genAiPartConverter,
      adkEventConverter: noopAdkEventConverter,
    });

    expect(resolved.a2aPartConverter).toBe(a2aPartConverter);
    expect(resolved.genAiPartConverter).toBe(genAiPartConverter);
    expect(resolved.adkEventConverter).toBe(noopAdkEventConverter);
  });

  it('treats an explicit undefined as unset', () => {
    const resolved = resolveA2aAgentExecutorConfig({
      a2aPartConverter: undefined,
      genAiPartConverter: undefined,
      adkEventConverter: undefined,
    });

    expect(resolved).toEqual(resolveA2aAgentExecutorConfig({}));
  });

  it('does not mutate the config it was given', () => {
    const config: A2aAgentExecutorConverterConfig = {};

    resolveA2aAgentExecutorConfig(config);

    expect(config).toEqual({});
  });

  it.each([
    ['a2aPartConverter', 'number', 3],
    ['genAiPartConverter', 'null', null],
    ['eventConverter', 'string', 'nope'],
    ['adkEventConverter', 'object', {}],
  ])('rejects a %s that is a %s', (field, described, value) => {
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

    const first = onlyArtifactUpdate(
      toA2AArtifactUpdateEventsFromArtifactMap(
        modelEvent('chunk 1', true),
        agentsArtifacts,
        TASK_ID,
        CONTEXT_ID,
        defaultGenAiPartConverter,
      ),
    );
    const last = onlyArtifactUpdate(
      toA2AArtifactUpdateEventsFromArtifactMap(
        modelEvent('chunk 2'),
        agentsArtifacts,
        TASK_ID,
        CONTEXT_ID,
        defaultGenAiPartConverter,
      ),
    );

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

    const event = onlyArtifactUpdate(
      toA2AArtifactUpdateEventsFromArtifactMap(
        modelEvent('original'),
        new Map(),
        TASK_ID,
        CONTEXT_ID,
        genAiPartConverter,
      ),
    );

    expect((event.artifact.parts[0] as TextPart).text).toBe('rewritten');
    expect(genAiPartConverter).toHaveBeenCalledTimes(1);
  });

  it('drops a part its converter returns undefined for', () => {
    const event = onlyArtifactUpdate(
      toA2AArtifactUpdateEventsFromArtifactMap(
        createEvent({
          author: 'model',
          content: {role: 'model', parts: [{text: 'secret'}, {text: 'public'}]},
          actions: createEventActions(),
        }),
        new Map(),
        TASK_ID,
        CONTEXT_ID,
        (part) =>
          part.text === 'secret'
            ? undefined
            : {kind: 'text', text: part.text ?? ''},
      ),
    );

    expect(event.artifact.parts).toEqual([{kind: 'text', text: 'public'}]);
  });

  it('publishes nothing when its converter drops every part', () => {
    const agentsArtifacts = new Map<string, string>();

    const events = toA2AArtifactUpdateEventsFromArtifactMap(
      modelEvent('secret', true),
      agentsArtifacts,
      TASK_ID,
      CONTEXT_ID,
      () => undefined,
    );

    expect(events).toEqual([]);
    expect(agentsArtifacts.size).toBe(0);
  });

  it('falls back to toA2APart when no converter is supplied', () => {
    const event = onlyArtifactUpdate(
      toA2AArtifactUpdateEventsFromArtifactMap(
        modelEvent('original'),
        new Map(),
        TASK_ID,
        CONTEXT_ID,
      ),
    );

    expect((event.artifact.parts[0] as TextPart).text).toBe('original');
  });

  it('keys an authorless event under one bucket of its own', () => {
    const agentsArtifacts = new Map<string, string>();

    onlyArtifactUpdate(
      toA2AArtifactUpdateEventsFromArtifactMap(
        createEvent({
          content: {role: 'model', parts: [{text: 'chunk 1'}]},
          partial: true,
          actions: createEventActions(),
        }),
        agentsArtifacts,
        TASK_ID,
        CONTEXT_ID,
        defaultGenAiPartConverter,
      ),
    );

    expect([...agentsArtifacts.keys()]).toEqual(['']);
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

    mockSessionService.getSession.mockResolvedValue(
      createSession({
        id: 'session-id',
        userId: 'test-user',
        appName: 'test-app',
      }),
    );
  });

  const runnerConfig = (): RunnerConfig => ({
    appName: 'test-app',
    sessionService: mockSessionService,
  });

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

  it('runs the configured adkEventConverter instead of the default', async () => {
    stubRunnerWithGate(async () => {});
    const adkEventConverter: AdkEventToA2AEventsConverterImpl = vi.fn(() => []);

    const executor = new A2AAgentExecutor({
      runner: runnerConfig(),
      adkEventConverter,
    });
    await executor.execute(requestContext('a'), mockEventBus);

    expect(adkEventConverter).toHaveBeenCalledTimes(2);
    // Nothing was published for either ADK event.
    const kinds = mockEventBus.publish.mock.calls.map(([event]) => event.kind);
    expect(kinds).toEqual(['task', 'status-update', 'status-update']);
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
