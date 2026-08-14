/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message, TaskArtifactUpdateEvent} from '@a2a-js/sdk';
import {
  AgentExecutionEvent,
  DefaultExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  BaseAgent,
  BaseArtifactService,
  createEvent,
  createEventActions,
  Event,
  ExecutorContext,
  includeArtifactsInA2AEvent,
  InMemoryArtifactService,
  InMemorySessionService,
  InvocationContext,
  Runner,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

const APP_NAME = 'artifact-app';
const USER_ID = 'user-1';
const SESSION_ID = 'session-1';
const TASK_ID = 'task-1';

class SilentAgent extends BaseAgent {
  constructor() {
    super({name: 'silent_agent'});
  }

  protected async *runAsyncImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

function createRequestContext(): RequestContext {
  const message: Message = {
    kind: 'message',
    messageId: 'message-1',
    role: 'user',
    parts: [{kind: 'text', text: 'hello'}],
  };

  return new RequestContext(message, TASK_ID, SESSION_ID);
}

function createConvertedEvent(): TaskArtifactUpdateEvent {
  return {
    kind: 'artifact-update',
    taskId: TASK_ID,
    contextId: SESSION_ID,
    append: false,
    lastChunk: true,
    artifact: {
      artifactId: 'converted-artifact',
      parts: [{kind: 'text', text: 'agent said hello'}],
    },
    metadata: {'adk_app_name': APP_NAME},
  };
}

function createContext(artifactService?: BaseArtifactService): ExecutorContext {
  const runner = new Runner({
    appName: APP_NAME,
    agent: new SilentAgent(),
    sessionService: new InMemorySessionService(),
    artifactService,
  });

  return {
    userId: USER_ID,
    sessionId: SESSION_ID,
    appName: APP_NAME,
    readonlyState: {},
    events: [],
    userContent: {role: 'user', parts: [{text: 'hello'}]},
    requestContext: createRequestContext(),
    runner,
  };
}

function saveArtifact(
  artifactService: BaseArtifactService,
  filename: string,
  artifact: Part,
): Promise<number> {
  return artifactService.saveArtifact({
    appName: APP_NAME,
    userId: USER_ID,
    sessionId: SESSION_ID,
    filename,
    artifact,
  });
}

function adkEventWithDelta(artifactDelta: {[filename: string]: number}): Event {
  return createEvent({
    author: 'silent_agent',
    content: {role: 'model', parts: [{text: 'agent said hello'}]},
    actions: createEventActions({artifactDelta}),
  });
}

/** Narrows a handler result that must be several events. */
function expectEvents(
  result: AgentExecutionEvent | AgentExecutionEvent[] | undefined,
  length: number,
): AgentExecutionEvent[] {
  if (!Array.isArray(result)) {
    expect.fail(`expected ${length} events, got a single result`);
  }
  expect(result).toHaveLength(length);

  return result;
}

/** Narrows a published event that must be an artifact update. */
function expectArtifactUpdate(
  event: AgentExecutionEvent,
): TaskArtifactUpdateEvent {
  if (event.kind !== 'artifact-update') {
    expect.fail(`expected an artifact update, got ${event.kind}`);
  }

  return event;
}

describe('includeArtifactsInA2AEvent', () => {
  it('publishes the converted event followed by the saved artifact', async () => {
    const artifactService = new InMemoryArtifactService();
    const version = await saveArtifact(artifactService, 'report.md', {
      text: 'hello',
    });
    const ctx = createContext(artifactService);
    const load = vi.spyOn(artifactService, 'loadArtifact');
    const a2aEvent = createConvertedEvent();

    const result = await includeArtifactsInA2AEvent(
      ctx,
      adkEventWithDelta({'report.md': version}),
      a2aEvent,
    );

    const events = expectEvents(result, 2);
    expect(events[0]).toBe(a2aEvent);

    const artifactEvent = expectArtifactUpdate(events[1]);
    expect(artifactEvent.artifact.artifactId).toBe('report.md_0');
    expect(artifactEvent.artifact.name).toBe('report.md');
    expect(artifactEvent.artifact.parts).toEqual([
      {kind: 'text', text: 'hello'},
    ]);
    expect(artifactEvent.taskId).toBe(TASK_ID);
    expect(artifactEvent.contextId).toBe(SESSION_ID);
    expect(artifactEvent.metadata).toEqual({'adk_app_name': APP_NAME});
    expect(artifactEvent.append).toBe(false);
    expect(artifactEvent.lastChunk).toBe(true);

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: SESSION_ID,
      filename: 'report.md',
      version: 0,
    });
  });

  it('publishes one artifact event per delta entry, in delta order', async () => {
    const artifactService = new InMemoryArtifactService();
    await saveArtifact(artifactService, 'a.txt', {text: 'first'});
    await saveArtifact(artifactService, 'b.png', {text: 'placeholder'});
    await saveArtifact(artifactService, 'b.png', {text: 'placeholder'});
    const imageVersion = await saveArtifact(artifactService, 'b.png', {
      inlineData: {mimeType: 'image/png', data: 'aGk='},
    });
    const ctx = createContext(artifactService);

    const result = await includeArtifactsInA2AEvent(
      ctx,
      adkEventWithDelta({'a.txt': 0, 'b.png': imageVersion}),
      createConvertedEvent(),
    );

    const events = expectEvents(result, 3);

    const textEvent = expectArtifactUpdate(events[1]);
    expect(textEvent.artifact.artifactId).toBe('a.txt_0');
    expect(textEvent.artifact.parts).toEqual([{kind: 'text', text: 'first'}]);

    const imageEvent = expectArtifactUpdate(events[2]);
    expect(imageEvent.artifact.artifactId).toBe('b.png_2');
    expect(imageEvent.artifact.name).toBe('b.png');
    expect(imageEvent.artifact.parts[0].kind).toBe('file');
  });

  it('returns the converted event when the runner has no artifact service', async () => {
    const ctx = createContext();
    const a2aEvent = createConvertedEvent();

    const result = await includeArtifactsInA2AEvent(
      ctx,
      adkEventWithDelta({'report.md': 0}),
      a2aEvent,
    );

    expect(result).toBe(a2aEvent);
  });

  it('returns the converted event when the delta is empty', async () => {
    const artifactService = new InMemoryArtifactService();
    const ctx = createContext(artifactService);
    const load = vi.spyOn(artifactService, 'loadArtifact');
    const a2aEvent = createConvertedEvent();

    const result = await includeArtifactsInA2AEvent(
      ctx,
      adkEventWithDelta({}),
      a2aEvent,
    );

    expect(result).toBe(a2aEvent);
    expect(load).not.toHaveBeenCalled();
  });

  it('skips a delta entry whose artifact version is gone', async () => {
    const artifactService = new InMemoryArtifactService();
    await saveArtifact(artifactService, 'kept.txt', {text: 'still here'});
    const ctx = createContext(artifactService);

    const result = await includeArtifactsInA2AEvent(
      ctx,
      adkEventWithDelta({'gone.txt': 0, 'kept.txt': 0}),
      createConvertedEvent(),
    );

    const events = expectEvents(result, 2);
    expect(expectArtifactUpdate(events[1]).artifact.artifactId).toBe(
      'kept.txt_0',
    );
  });

  it('skips an inline blob that carries no data', async () => {
    const artifactService = new InMemoryArtifactService();
    await saveArtifact(artifactService, 'empty.png', {
      inlineData: {mimeType: 'image/png'},
    });
    const ctx = createContext(artifactService);
    const a2aEvent = createConvertedEvent();

    const result = await includeArtifactsInA2AEvent(
      ctx,
      adkEventWithDelta({'empty.png': 0}),
      a2aEvent,
    );

    expect(result).toBe(a2aEvent);
  });

  it('skips a part with no payload at all', async () => {
    const artifactService = new InMemoryArtifactService();
    vi.spyOn(artifactService, 'loadArtifact').mockResolvedValue({});
    const ctx = createContext(artifactService);
    const a2aEvent = createConvertedEvent();

    const result = await includeArtifactsInA2AEvent(
      ctx,
      adkEventWithDelta({'mystery.bin': 0}),
      a2aEvent,
    );

    expect(result).toBe(a2aEvent);
  });

  it('publishes an artifact whose text is empty', async () => {
    const artifactService = new InMemoryArtifactService();
    // InMemoryArtifactService refuses to store an empty text part, so the
    // stored value is supplied directly.
    vi.spyOn(artifactService, 'loadArtifact').mockResolvedValue({text: ''});
    const ctx = createContext(artifactService);

    const result = await includeArtifactsInA2AEvent(
      ctx,
      adkEventWithDelta({'blank.txt': 0}),
      createConvertedEvent(),
    );

    const events = expectEvents(result, 2);
    expect(expectArtifactUpdate(events[1]).artifact.parts).toEqual([
      {kind: 'text', text: ''},
    ]);
  });

  it('returns nothing when the ADK event produced no A2A event', async () => {
    const artifactService = new InMemoryArtifactService();
    const ctx = createContext(artifactService);
    const load = vi.spyOn(artifactService, 'loadArtifact');

    const result = await includeArtifactsInA2AEvent(
      ctx,
      adkEventWithDelta({'report.md': 0}),
    );

    expect(result).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it('leaves the ADK event artifact delta untouched', async () => {
    const artifactService = new InMemoryArtifactService();
    await saveArtifact(artifactService, 'report.md', {text: 'hello'});
    const ctx = createContext(artifactService);
    const adkEvent = adkEventWithDelta({'report.md': 0});

    await includeArtifactsInA2AEvent(ctx, adkEvent, createConvertedEvent());

    expect(adkEvent.actions.artifactDelta).toEqual({'report.md': 0});
  });
});

/**
 * Drives the real executor over real in-memory services, with no test doubles,
 * to prove the callback reaches the A2A stream.
 */
class ArtifactSavingAgent extends BaseAgent {
  constructor() {
    super({name: 'artifact_agent'});
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    const version = await context.artifactService!.saveArtifact({
      filename: 'note.txt',
      artifact: {text: 'hi'},
    });

    yield createEvent({
      author: this.name,
      invocationId: context.invocationId,
      content: {role: 'model', parts: [{text: 'saved the note'}]},
      actions: createEventActions({artifactDelta: {'note.txt': version}}),
    });
  }

  protected async *runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<Event, void, void> {}
}

async function runExecutor(
  installArtifactCallback: boolean,
): Promise<AgentExecutionEvent[]> {
  const runner = new Runner({
    appName: APP_NAME,
    agent: new ArtifactSavingAgent(),
    sessionService: new InMemorySessionService(),
    artifactService: new InMemoryArtifactService(),
  });
  const executor = new A2AAgentExecutor({
    runner,
    afterEventCallback: installArtifactCallback
      ? includeArtifactsInA2AEvent
      : undefined,
  });

  const published: AgentExecutionEvent[] = [];
  const eventBus = new DefaultExecutionEventBus();
  eventBus.on('event', (event) => published.push(event));

  await executor.execute(createRequestContext(), eventBus);

  return published;
}

describe('A2AAgentExecutor with includeArtifactsInA2AEvent', () => {
  it('publishes the saved artifact on the A2A stream', async () => {
    const published = await runExecutor(true);

    const artifactEvents = published.filter(
      (event): event is TaskArtifactUpdateEvent =>
        event.kind === 'artifact-update',
    );
    expect(artifactEvents).toHaveLength(2);
    expect(artifactEvents[1].artifact.name).toBe('note.txt');
    expect(artifactEvents[1].artifact.artifactId).toBe('note.txt_0');
    expect(artifactEvents[1].artifact.parts).toEqual([
      {kind: 'text', text: 'hi'},
    ]);
  });

  it('publishes no artifact update without the callback', async () => {
    const published = await runExecutor(false);

    const artifactEvents = published.filter(
      (event): event is TaskArtifactUpdateEvent =>
        event.kind === 'artifact-update',
    );
    expect(artifactEvents).toHaveLength(1);
    expect(artifactEvents[0].artifact.name).toBeUndefined();
  });
});
