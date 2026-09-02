/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseArtifactService,
  BaseMemoryService,
  BaseSessionService,
  Event,
  Runner,
  Session,
} from '@google/adk';
import {Readable} from 'node:stream';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {isPositiveResponse, runOnceCli} from '../../src/cli/cli_run.js';
import {AgentFile} from '../../src/utils/agent_loader.js';
import {loadFileData} from '../../src/utils/file_utils.js';

vi.mock('../../src/utils/agent_loader.js', () => ({
  AgentFile: vi.fn(),
}));

vi.mock('../../src/utils/file_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/file_utils.js')>()),
  loadFileData: vi.fn(),
}));

/** What the faked Runner yields, and what it was asked to run. */
const runnerState = vi.hoisted(() => ({
  events: [] as unknown[],
  calls: [] as unknown[],
  hang: false,
}));

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  return {
    ...actual,
    Runner: vi.fn().mockImplementation(() => ({
      runAsync: async function* (params: unknown) {
        runnerState.calls.push(params);
        if (runnerState.hang) {
          await new Promise(() => {});
        }
        for (const event of runnerState.events) {
          yield event;
        }
      },
    })),
    isApp: vi.fn().mockReturnValue(false),
  };
});

const TEXT_EVENT = {
  id: 'event-1',
  author: 'model',
  actions: {stateDelta: {}, artifactDelta: {}},
  content: {parts: [{text: 'Response from model'}]},
};

const INTERRUPT_ID = 'call-1';

function createSessionFake(events: Event[] = []): Session {
  return {
    id: 'session-123',
    appName: 'test-agent',
    userId: 'test_user',
    state: {},
    events,
    lastUpdateTime: 0,
  } as Session;
}

describe('runOnceCli', () => {
  let stdout: string[];
  let stderr: string[];
  let sessionService: BaseSessionService;
  let getSessionResult: Session | undefined;
  let originalStdin: typeof process.stdin;

  const services = () => ({
    sessionService,
    artifactService: {} as BaseArtifactService,
    memoryService: {} as BaseMemoryService,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = [];
    stderr = [];
    runnerState.events = [TEXT_EVENT];
    runnerState.calls = [];
    runnerState.hang = false;
    getSessionResult = undefined;
    originalStdin = process.stdin;

    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      stdout.push(args.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(' '));
    });

    (Runner as unknown as Mock).mockImplementation(() => ({
      runAsync: async function* (params: unknown) {
        runnerState.calls.push(params);
        if (runnerState.hang) {
          await new Promise(() => {});
        }
        for (const event of runnerState.events) {
          yield event;
        }
      },
    }));

    (AgentFile as unknown as Mock).mockImplementation(() => ({
      load: vi.fn().mockResolvedValue({name: 'test-agent'}),
      [Symbol.asyncDispose]: vi.fn(),
    }));

    sessionService = {
      createSession: vi.fn(async () => createSessionFake()),
      getSession: vi.fn(async () => getSessionResult),
    } as unknown as BaseSessionService;
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  const setStdin = (contents: string | undefined) => {
    const stream =
      contents === undefined
        ? Object.assign(Readable.from([]), {isTTY: true})
        : Object.assign(Readable.from([contents]), {isTTY: false});
    Object.defineProperty(process, 'stdin', {
      value: stream,
      configurable: true,
    });
  };

  it('runs the query and returns 0', async () => {
    const code = await runOnceCli({
      agentPath: 'agent.ts',
      query: 'hello',
      ...services(),
    });

    expect(code).toBe(0);
    expect(stdout).toContain('[model]: Response from model');
    expect(stderr).toContain('Session ID: session-123');
  });

  it('seeds the session with --state', async () => {
    await runOnceCli({
      agentPath: 'agent.ts',
      query: 'hello',
      stateStr: '{"city":"Boston"}',
      ...services(),
    });

    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({state: {city: 'Boston'}}),
    );
  });

  it('returns 1 for invalid --state JSON', async () => {
    const code = await runOnceCli({
      agentPath: 'agent.ts',
      query: 'hello',
      stateStr: '{not json',
      ...services(),
    });

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('Error: Invalid JSON for --state:');
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('returns 1 when --state is valid JSON but not an object', async () => {
    const code = await runOnceCli({
      agentPath: 'agent.ts',
      query: 'hello',
      stateStr: '[1, 2]',
      ...services(),
    });

    expect(code).toBe(1);
    expect(stderr).toContain(
      'Error: Invalid JSON for --state: expected a JSON object',
    );
  });

  it('returns 1 when a query and --replay are both given', async () => {
    const code = await runOnceCli({
      agentPath: 'agent.ts',
      query: 'hello',
      replay: 'replay.json',
      ...services(),
    });

    expect(code).toBe(1);
    expect(stderr).toContain('Error: Cannot provide both query and --replay.');
  });

  it('returns 1 when there is no query and stdin is a terminal', async () => {
    setStdin(undefined);

    const code = await runOnceCli({agentPath: 'agent.ts', ...services()});

    expect(code).toBe(1);
    expect(stderr).toContain('Error: Missing query argument or stdin input.');
  });

  it('reads the query from a piped stdin', async () => {
    setStdin('  piped question  \n');

    const code = await runOnceCli({agentPath: 'agent.ts', ...services()});

    expect(code).toBe(0);
    expect(runnerState.calls).toEqual([
      expect.objectContaining({
        newMessage: {role: 'user', parts: [{text: 'piped question'}]},
      }),
    ]);
  });

  it('runs every query of a --replay file', async () => {
    vi.mocked(loadFileData).mockResolvedValue({
      state: {city: 'Boston'},
      queries: ['first', 'second'],
    });

    const code = await runOnceCli({
      agentPath: 'agent.ts',
      replay: 'replay.json',
      ...services(),
    });

    expect(code).toBe(0);
    expect(runnerState.calls).toHaveLength(2);
    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({state: {city: 'Boston'}}),
    );
  });

  it('runs no query when the --replay file cannot be read', async () => {
    vi.mocked(loadFileData).mockResolvedValue(undefined);

    const code = await runOnceCli({
      agentPath: 'agent.ts',
      replay: 'replay.json',
      ...services(),
    });

    expect(code).toBe(0);
    expect(runnerState.calls).toEqual([]);
  });

  it('continues an existing session given --session_id', async () => {
    getSessionResult = createSessionFake();

    await runOnceCli({
      agentPath: 'agent.ts',
      query: 'hello',
      sessionId: 'session-123',
      ...services(),
    });

    expect(sessionService.getSession).toHaveBeenCalled();
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('creates the session when --session_id names an absent one', async () => {
    await runOnceCli({
      agentPath: 'agent.ts',
      query: 'hello',
      sessionId: 'session-123',
      ...services(),
    });

    expect(sessionService.createSession).toHaveBeenCalledWith(
      expect.objectContaining({sessionId: 'session-123'}),
    );
  });

  it('returns 1 with the timeout message when the budget runs out', async () => {
    runnerState.hang = true;

    const code = await runOnceCli({
      agentPath: 'agent.ts',
      query: 'hello',
      timeout: '0s',
      ...services(),
    });

    expect(code).toBe(1);
    expect(stderr).toContain('Error: Command timed out after 0s');
  });

  it('returns 1 with the message of any other failure', async () => {
    // An async iterable rather than a generator, so the stand-in can fail on
    // the first pull without a yield it would never reach.
    (Runner as unknown as Mock).mockImplementation(() => ({
      runAsync: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error('model exploded')),
        }),
      }),
    }));

    const code = await runOnceCli({
      agentPath: 'agent.ts',
      query: 'hello',
      ...services(),
    });

    expect(code).toBe(1);
    expect(stderr).toContain('Error: model exploded');
  });

  describe('pausing on human input', () => {
    const pausedEvent = {
      id: 'event-2',
      author: 'model',
      actions: {},
      longRunningToolIds: [INTERRUPT_ID],
      content: {
        parts: [
          {
            functionCall: {
              id: INTERRUPT_ID,
              name: 'adk_request_input',
              args: {},
            },
          },
        ],
      },
    };

    it('returns 2 and prints how to resume', async () => {
      runnerState.events = [pausedEvent];

      const code = await runOnceCli({
        agentPath: 'agent.ts',
        query: 'hello',
        ...services(),
      });

      expect(code).toBe(2);
      expect(stderr.join('')).toContain(
        '[PAUSED] Workflow is waiting for human input!',
      );
      expect(stderr.join('')).toContain('--session_id session-123');
    });

    it('stays quiet about the pause under --jsonl', async () => {
      runnerState.events = [pausedEvent];

      const code = await runOnceCli({
        agentPath: 'agent.ts',
        query: 'hello',
        jsonl: true,
        ...services(),
      });

      expect(code).toBe(2);
      expect(stderr).toEqual([]);
    });
  });

  describe('auto-resume', () => {
    const interruptEvent = (name: string): Event =>
      ({
        id: 'event-2',
        author: 'model',
        actions: {},
        longRunningToolIds: [INTERRUPT_ID],
        content: {parts: [{functionCall: {id: INTERRUPT_ID, name, args: {}}}]},
      }) as Event;

    const resumeWith = async (name: string, query: string) => {
      getSessionResult = createSessionFake([interruptEvent(name)]);
      await runOnceCli({
        agentPath: 'agent.ts',
        query,
        sessionId: 'session-123',
        ...services(),
      });
      const call = runnerState.calls[0] as {
        newMessage: {parts: Array<{functionResponse?: unknown}>};
      };
      return call.newMessage.parts[0].functionResponse;
    };

    it('answers an input request with the query text', async () => {
      expect(await resumeWith('adk_request_input', 'Boston')).toEqual({
        id: INTERRUPT_ID,
        name: 'adk_request_input',
        response: {result: 'Boston'},
      });
    });

    it('answers an unnamed interrupt as an input request', async () => {
      getSessionResult = createSessionFake([
        {
          id: 'event-2',
          author: 'model',
          actions: {},
          longRunningToolIds: [INTERRUPT_ID],
        } as Event,
      ]);

      await runOnceCli({
        agentPath: 'agent.ts',
        query: 'Boston',
        sessionId: 'session-123',
        ...services(),
      });

      const call = runnerState.calls[0] as {
        newMessage: {parts: Array<{functionResponse?: {name?: string}}>};
      };
      expect(call.newMessage.parts[0].functionResponse?.name).toBe(
        'adk_request_input',
      );
    });

    it.each([
      ['yes', {confirmed: true}],
      ['no', {confirmed: false}],
      ['{"confirmed": true, "note": "ok"}', {confirmed: true, note: 'ok'}],
      ['[1, 2]', {confirmed: false}],
    ])('answers a confirmation request given %s', async (query, expected) => {
      expect(await resumeWith('adk_request_confirmation', query)).toEqual({
        id: INTERRUPT_ID,
        name: 'adk_request_confirmation',
        response: expected,
      });
    });

    it('announces the resume on stderr', async () => {
      await resumeWith('adk_request_input', 'Boston');

      expect(stderr.join('')).toContain(
        `Auto-resuming interrupt ${INTERRUPT_ID} with input: Boston`,
      );
    });

    it('says nothing about the resume under --jsonl', async () => {
      getSessionResult = createSessionFake([
        interruptEvent('adk_request_input'),
      ]);

      await runOnceCli({
        agentPath: 'agent.ts',
        query: 'Boston',
        sessionId: 'session-123',
        jsonl: true,
        ...services(),
      });

      expect(stderr).toEqual([]);
    });
  });

  describe('--jsonl output', () => {
    it('emits one record per event with the session id and ordered keys', async () => {
      const code = await runOnceCli({
        agentPath: 'agent.ts',
        query: 'hello',
        jsonl: true,
        ...services(),
      });

      expect(code).toBe(0);
      expect(stdout).toHaveLength(1);
      const record: unknown = JSON.parse(stdout[0]);
      expect(record).toEqual({
        author: 'model',
        session_id: 'session-123',
        id: 'event-1',
        content: {parts: [{text: 'Response from model'}]},
      });
      expect(Object.keys(record as object)).toEqual([
        'author',
        'session_id',
        'id',
        'content',
      ]);
    });

    it('keeps the session id off stdout', async () => {
      await runOnceCli({
        agentPath: 'agent.ts',
        query: 'hello',
        jsonl: true,
        ...services(),
      });

      expect(stderr).toEqual([]);
    });
  });
});

describe('isPositiveResponse', () => {
  it.each([['y'], ['Y'], ['yes'], [' YES '], ['true'], ['confirm']])(
    'reads %s as positive',
    (value) => {
      expect(isPositiveResponse(value)).toBe(true);
    },
  );

  it.each([['n'], ['no'], ['maybe'], ['']])('reads %s as negative', (value) => {
    expect(isPositiveResponse(value)).toBe(false);
  });
});
