/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the service wrappers `Context` gained for parity with adk-python.
 *
 * The tests named `test_*` are ports of
 * `tests/unittests/agents/test_context.py` on `google/adk-python` `main`, and
 * keep the Python test name so the two suites stay greppable against each
 * other. Every service here is a real in-memory implementation, so the
 * assertions exercise the whole write-then-read path rather than a call
 * recording.
 */

import {
  AuthConfig,
  AuthScheme,
  BaseMemoryService,
  Context,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InvocationContext,
  PluginManager,
  Session,
  SessionArtifactService,
  createEvent,
  createSession,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {ScopedArtifactService} from '../../src/artifacts/scoped_artifact_service.js';

const APP_NAME = 'test-app';
const USER_ID = 'test-user';
const SESSION_ID = 'test-session-id';

function makeSession(events: Session['events'] = []): Session {
  return createSession({
    id: SESSION_ID,
    appName: APP_NAME,
    userId: USER_ID,
    events,
  });
}

function makeContext(
  options: {
    session?: Session;
    artifactService?: SessionArtifactService;
    memoryService?: BaseMemoryService;
    isolationScope?: string;
    functionCallId?: string;
  } = {},
): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: options.session ?? makeSession(),
      pluginManager: new PluginManager(),
      artifactService: options.artifactService,
      memoryService: options.memoryService,
      isolationScope: options.isolationScope,
    }),
    functionCallId: options.functionCallId,
  });
}

function makeArtifactService(): SessionArtifactService {
  return new ScopedArtifactService(
    new InMemoryArtifactService(),
    APP_NAME,
    USER_ID,
    SESSION_ID,
  );
}

const TEXT_ARTIFACT: Part = {text: 'test content'};

describe('Context.saveArtifact', () => {
  it('test_save_artifact', async () => {
    const context = makeContext({artifactService: makeArtifactService()});

    const version = await context.saveArtifact('test_file.txt', TEXT_ARTIFACT);

    expect(version).toBe(0);
    expect(context.actions.artifactDelta['test_file.txt']).toBe(0);
    expect(await context.loadArtifact('test_file.txt')).toEqual(TEXT_ARTIFACT);
  });

  it('stores the custom metadata alongside the version', async () => {
    const context = makeContext({artifactService: makeArtifactService()});

    await context.saveArtifact('report.txt', TEXT_ARTIFACT, {
      source: 'unit-test',
      pages: 3,
    });

    const stored = await context.getArtifactVersion('report.txt');
    expect(stored?.customMetadata).toEqual({source: 'unit-test', pages: 3});
  });

  it('leaves the custom metadata unset when the caller omits it', async () => {
    const context = makeContext({artifactService: makeArtifactService()});

    await context.saveArtifact('report.txt', TEXT_ARTIFACT);

    const stored = await context.getArtifactVersion('report.txt');
    expect(stored?.customMetadata).toBeUndefined();
  });
});

describe('Context.getArtifactVersion', () => {
  it('returns the latest version when the caller gives no version', async () => {
    const context = makeContext({artifactService: makeArtifactService()});
    await context.saveArtifact('notes.txt', TEXT_ARTIFACT, {round: 'first'});
    await context.saveArtifact('notes.txt', TEXT_ARTIFACT, {round: 'second'});

    const stored = await context.getArtifactVersion('notes.txt');

    expect(stored?.version).toBe(1);
    expect(stored?.customMetadata).toEqual({round: 'second'});
  });

  it('returns the version the caller asks for', async () => {
    const context = makeContext({artifactService: makeArtifactService()});
    await context.saveArtifact('notes.txt', TEXT_ARTIFACT, {round: 'first'});
    await context.saveArtifact('notes.txt', TEXT_ARTIFACT, {round: 'second'});

    const stored = await context.getArtifactVersion('notes.txt', 0);

    expect(stored?.version).toBe(0);
    expect(stored?.customMetadata).toEqual({round: 'first'});
  });

  it('resolves undefined for an artifact the session does not hold', async () => {
    const context = makeContext({artifactService: makeArtifactService()});

    expect(await context.getArtifactVersion('absent.txt')).toBeUndefined();
  });

  it('throws when the artifact service is missing', () => {
    const context = makeContext();

    expect(() => context.getArtifactVersion('notes.txt')).toThrow(
      'Artifact service is not initialized.',
    );
  });
});

describe('Context.addSessionToMemory', () => {
  it('test_add_session_to_memory_success', async () => {
    const memoryService = new InMemoryMemoryService();
    const session = makeSession([
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'the umbrella is blue'}]},
      }),
    ]);
    const context = makeContext({session, memoryService});

    await context.addSessionToMemory();

    const found = await context.searchMemory('umbrella');
    expect(found.memories).toHaveLength(1);
    expect(found.memories[0].content?.parts?.[0].text).toBe(
      'the umbrella is blue',
    );
  });

  it('test_add_session_to_memory_no_service_raises', () => {
    const context = makeContext();

    expect(() => context.addSessionToMemory()).toThrow(
      'Cannot add session to memory: memory service is not available.',
    );
  });
});

describe('Context.isolationScope', () => {
  it('reads the scope through from the invocation context', () => {
    const context = makeContext({isolationScope: 'wf.worker#1'});

    expect(context.isolationScope).toBe('wf.worker#1');
  });

  it('is undefined when the invocation runs under no scope', () => {
    expect(makeContext().isolationScope).toBeUndefined();
  });
});

describe('Context.functionCallId', () => {
  it('is writable after construction', () => {
    const context = makeContext();
    const authConfig: AuthConfig = {
      credentialKey: 'key1',
      authScheme: {} as AuthScheme,
    };
    expect(() => context.requestCredential(authConfig)).toThrow(
      'functionCallId is not set.',
    );

    context.functionCallId = 'call-42';
    context.requestCredential(authConfig);

    expect(Object.keys(context.actions.requestedAuthConfigs)).toStrictEqual([
      'call-42',
    ]);
  });

  it('keeps the id the constructor was given', () => {
    expect(makeContext({functionCallId: 'call-1'}).functionCallId).toBe(
      'call-1',
    );
  });
});
