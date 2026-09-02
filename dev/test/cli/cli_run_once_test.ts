/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseSessionService,
  createEvent,
  createSession,
  CreateSessionRequest,
  Event,
  GetSessionRequest,
  ListSessionsResponse,
  Runner,
  Session,
} from '@google/adk';
import {Content} from '@google/genai';
import {Readable} from 'node:stream';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  Mock,
  MockInstance,
  vi,
} from 'vitest';
import {runAgentOnce} from '../../src/cli/cli_run_once.js';
import {AgentFile} from '../../src/utils/agent_loader.js';
import {loadFileData} from '../../src/utils/file_utils.js';

vi.mock('../../src/utils/agent_loader.js', () => ({
  AgentFile: vi.fn(),
}));

// Only the I/O is faked; getAbsolutePath is the real resolver.
vi.mock('../../src/utils/file_utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/file_utils.js')>()),
  loadFileData: vi.fn(),
}));

// A plain function, not a spy: `restoreAllMocks` would strip a spy and leave
// the next case without a decision.
vi.mock('../../src/cli/local_storage.js', () => ({
  resolveUseLocalStorage: async () => ({useLocalStorage: false}),
  createLocalSessionService: vi.fn(),
  createLocalArtifactService: vi.fn(),
}));

/** Events the fake runner yields per turn; set per test. */
const runnerState = vi.hoisted(() => ({
  events: [] as Event[],
}));

// Only the Runner is faked, so the interrupt detection under test is the real
// `getFunctionCalls`.
vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  return {...actual, Runner: vi.fn()};
});

/** What a turn was asked to run. */
interface RecordedTurn {
  newMessage: Content;
  sessionId: string;
  abortSignal?: AbortSignal;
}

/** A session the fake service hands out and records events against. */
function fakeSession(id: string, events: Event[] = []): Session {
  return createSession({
    id,
    appName: 'test-agent',
    userId: 'test_user',
    events,
  });
}

describe('runAgentOnce', () => {
  let turns: RecordedTurn[];
  let sessions: Map<string, Session>;
  let stderr: Mock;
  let stdout: Mock;
  let stdoutWrites: MockInstance<typeof process.stdout.write>;
  let stderrWrites: MockInstance<typeof process.stderr.write>;
  const realStdin = process.stdin;

  /** Everything written to stderr, as one string. */
  const stderrText = () =>
    stderr.mock.calls.map((call) => call.join(' ')).join('\n');

  /** Everything written to stdout, one entry per call. */
  const stdoutLines = () => stdout.mock.calls.map((call) => call.join(' '));

  /** What the real stdout stream received, which is where a record goes. */
  const stdoutChunks = () =>
    stdoutWrites.mock.calls.map((call) => String(call[0]));

  /** What the real stderr stream received. */
  const stderrChunks = () =>
    stderrWrites.mock.calls.map((call) => String(call[0]));

  /**
   * A session service backed by a map. It extends the base class so
   * `getOrCreateSession`, which decides whether --session_id reuses a session,
   * is the real implementation.
   */
  class FakeSessionService extends BaseSessionService {
    readonly created: Array<Record<string, unknown>> = [];

    constructor(private readonly stored: Map<string, Session>) {
      super();
    }

    override async createSession(
      request: CreateSessionRequest,
    ): Promise<Session> {
      this.created.push({...request});
      const session = fakeSession(request.sessionId ?? 'session-new');
      session.state = {...(request.state ?? {})};
      this.stored.set(session.id, session);
      return session;
    }

    override async getSession(
      request: GetSessionRequest,
    ): Promise<Session | undefined> {
      return this.stored.get(request.sessionId);
    }

    override async listSessions(): Promise<ListSessionsResponse> {
      const sessions = [...this.stored.values()];
      return {
        sessions,
        page: 1,
        limit: sessions.length,
        totalItems: sessions.length,
        totalPages: 1,
      };
    }

    override async deleteSession(): Promise<void> {}
  }

  function useSessionService(existing?: Session): void {
    sessions = new Map();
    if (existing) {
      sessions.set(existing.id, existing);
    }
    sessionService = new FakeSessionService(sessions);
  }

  let sessionService: FakeSessionService;

  beforeEach(() => {
    vi.clearAllMocks();
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {}) as Mock;
    stdout = vi.spyOn(console, 'log').mockImplementation(() => {}) as Mock;
    stdoutWrites = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrWrites = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    runnerState.events = [
      createEvent({
        author: 'model',
        content: {parts: [{text: 'Sunny in Paris.'}]},
      }),
    ];
    turns = [];

    (Runner as unknown as Mock).mockImplementation(() => ({
      runAsync: async function* (params: RecordedTurn) {
        turns.push(params);
        for (const event of runnerState.events) {
          yield event;
        }
      },
    }));

    (AgentFile as unknown as Mock).mockImplementation(() => ({
      load: vi.fn().mockResolvedValue({name: 'test-agent'} as BaseAgent),
      dispose: vi.fn(),
      [Symbol.asyncDispose]: vi.fn(),
    }));

    useSessionService();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'stdin', {
      value: realStdin,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  /** Runs one query against a session service seeded with `existing`. */
  async function run(
    options: Record<string, unknown> = {},
    existing?: Session,
  ): Promise<number> {
    useSessionService(existing);
    return runAgentOnce({
      agentPath: 'agent.ts',
      inMemory: true,
      sessionService,
      ...options,
    });
  }

  it('runs the query and reports success', async () => {
    const code = await run({query: 'weather?'});

    expect(code).toBe(0);
    expect(turns).toHaveLength(1);
    expect(turns[0].newMessage).toEqual({
      role: 'user',
      parts: [{text: 'weather?'}],
    });
    expect(stdoutLines()).toEqual(['[model]: Sunny in Paris.']);
  });

  it('prints the session id on stderr, not stdout', async () => {
    await run({query: 'weather?'});

    expect(stderrText()).toContain('Session ID: session-new');
    expect(stdoutLines().join('\n')).not.toContain('Session ID');
  });

  it('seeds a new session with --state', async () => {
    await run({query: 'weather?', state: '{"tier":"gold"}'});

    expect(sessionService.created[0]).toMatchObject({state: {tier: 'gold'}});
  });

  it('reports invalid --state JSON and runs nothing', async () => {
    const code = await run({query: 'weather?', state: '{tier: gold}'});

    expect(code).toBe(1);
    expect(stderrText()).toMatch(/Invalid JSON for --state/);
    expect(turns).toHaveLength(0);
  });

  it('refuses a query together with --replay', async () => {
    const code = await run({query: 'weather?', replay: 'replay.json'});

    expect(code).toBe(1);
    expect(stderrText()).toContain(
      'Error: Cannot provide both query and --replay.',
    );
    expect(turns).toHaveLength(0);
  });

  it('refuses a run with no query and a terminal on stdin', async () => {
    const code = await run({});

    expect(code).toBe(1);
    expect(stderrText()).toContain(
      'Error: Missing query argument or stdin input.',
    );
  });

  it('reads the query from a pipe when the argument is empty', async () => {
    Object.defineProperty(process, 'stdin', {
      value: Readable.from(['hello from the pipe\n']),
      configurable: true,
    });

    const code = await run({query: ''});

    expect(code).toBe(0);
    expect(turns[0].newMessage.parts).toEqual([{text: 'hello from the pipe'}]);
  });

  it('refuses a run whose piped query is empty', async () => {
    Object.defineProperty(process, 'stdin', {
      value: Readable.from(['   \n']),
      configurable: true,
    });

    const code = await run({query: ''});

    expect(code).toBe(1);
    expect(stderrText()).toContain('Missing query argument or stdin input.');
  });

  it('treats an event that carries no long-running ids as finished', async () => {
    const event = createEvent({
      author: 'model',
      content: {parts: [{text: 'done'}]},
    });
    // An event a caller built by hand can omit the field entirely.
    Reflect.deleteProperty(event, 'longRunningToolIds');
    runnerState.events = [event];

    expect(await run({query: 'weather?'})).toBe(0);
  });

  it('finishes a run whose long-running tool asks the user nothing', async () => {
    runnerState.events = [
      createEvent({
        author: 'agent',
        longRunningToolIds: ['job_1'],
        content: {
          parts: [
            {functionCall: {name: 'start_backup', id: 'job_1', args: {}}},
          ],
        },
      }),
    ];

    // Only a request for a human pauses a run; a tool that merely takes a
    // while does not.
    expect(await run({query: 'back up'})).toBe(0);
    expect(stderrText()).not.toContain('[PAUSED]');
  });

  describe('a paused run', () => {
    beforeEach(() => {
      runnerState.events = [
        createEvent({
          author: 'step1',
          longRunningToolIds: ['interrupt_123'],
          content: {
            parts: [
              {
                functionCall: {
                  name: 'adk_request_input',
                  id: 'interrupt_123',
                  args: {message: 'Which city?'},
                },
              },
            ],
          },
        }),
      ];
    });

    it('exits 2 and says how to resume', async () => {
      const code = await run({query: 'weather?'});

      expect(code).toBe(2);
      expect(stderrText()).toContain('[PAUSED]');
      expect(stderrText()).toContain('--session_id session-new');
    });

    it('keeps stdout clean in --jsonl mode', async () => {
      const code = await run({query: 'weather?', jsonl: true});

      expect(code).toBe(2);
      expect(stderrText()).not.toContain('[PAUSED]');
      expect(stderrText()).not.toContain('Session ID');
      // Read the real stream, not a stubbed console: that is where a record
      // goes, and where a line that breaks a parser would appear.
      expect(stdoutChunks()).toHaveLength(1);
      expect(() => JSON.parse(stdoutChunks()[0])).not.toThrow();
    });

    it('moves a write from the agent off stdout in --jsonl mode', async () => {
      (Runner as unknown as Mock).mockImplementation(() => ({
        runAsync: async function* (params: RecordedTurn) {
          turns.push(params);
          // What the copy of the ADK logger an agent loads does, and what the
          // CLI cannot silence by setting its own log level.
          process.stdout.write('WARN: [ADK] Class Workflow is experimental.\n');
          for (const event of runnerState.events) {
            yield event;
          }
        },
      }));

      const code = await run({query: 'weather?', jsonl: true});

      expect(code).toBe(2);
      for (const chunk of stdoutChunks()) {
        expect(() => JSON.parse(chunk)).not.toThrow();
      }
      expect(stderrChunks().join('')).toContain(
        'Class Workflow is experimental',
      );
    });
  });

  describe('auto-resume', () => {
    /** A session paused on the named interrupt. */
    const pausedSession = (functionCallName: string) =>
      fakeSession('session-1', [
        createEvent({
          author: 'user',
          content: {parts: [{text: 'delete everything'}]},
        }),
        createEvent({
          author: 'step1',
          longRunningToolIds: ['interrupt_123'],
          content: {
            parts: [
              {
                functionCall: {
                  name: functionCallName,
                  id: 'interrupt_123',
                  args: {},
                },
              },
            ],
          },
        }),
      ]);

    it('answers a pending input request with the query', async () => {
      const code = await run(
        {query: 'approve', sessionId: 'session-1'},
        pausedSession('adk_request_input'),
      );

      expect(code).toBe(0);
      expect(turns[0].newMessage.parts).toEqual([
        {
          functionResponse: {
            id: 'interrupt_123',
            name: 'adk_request_input',
            response: {result: 'approve'},
          },
        },
      ]);
      expect(stderrText()).toContain(
        'Auto-resuming interrupt interrupt_123 with input: approve',
      );
    });

    it.each([
      ['yes', true],
      ['no', false],
    ])(
      'answers a pending confirmation %o as confirmed=%s',
      async (query, confirmed) => {
        await run(
          {query, sessionId: 'session-1'},
          pausedSession('adk_request_confirmation'),
        );

        expect(turns[0].newMessage.parts?.[0].functionResponse).toEqual({
          id: 'interrupt_123',
          name: 'adk_request_confirmation',
          response: {confirmed},
        });
      },
    );

    it('passes a JSON confirmation payload through', async () => {
      await run(
        {query: '{"confirmed":true,"scope":"today"}', sessionId: 'session-1'},
        pausedSession('adk_request_confirmation'),
      );

      expect(turns[0].newMessage.parts?.[0].functionResponse?.response).toEqual(
        {confirmed: true, scope: 'today'},
      );
    });

    it('answers an unrecognised interrupt as an input request', async () => {
      await run(
        {query: 'a-token', sessionId: 'session-1'},
        pausedSession('adk_request_credential'),
      );

      expect(turns[0].newMessage.parts?.[0].functionResponse).toEqual({
        id: 'interrupt_123',
        name: 'adk_request_input',
        response: {result: 'a-token'},
      });
    });

    it('stays quiet about the resume in --jsonl mode', async () => {
      await run(
        {query: 'approve', sessionId: 'session-1', jsonl: true},
        pausedSession('adk_request_input'),
      );

      expect(stderrText()).not.toContain('Auto-resuming');
    });

    /** The function response that answers the interrupt above. */
    const answerEvent = (functionCallName: string) =>
      createEvent({
        author: 'user',
        content: {
          parts: [
            {
              functionResponse: {
                id: 'interrupt_123',
                name: functionCallName,
                response: {result: 'yes'},
              },
            },
          ],
        },
      });

    it('sends a plain message once the interrupt has been answered', async () => {
      const session = pausedSession('adk_request_input');
      session.events.push(answerEvent('adk_request_input'));

      const code = await run(
        {query: 'what is 2+2', sessionId: 'session-1'},
        session,
      );

      expect(code).toBe(0);
      expect(turns[0].newMessage).toEqual({
        role: 'user',
        parts: [{text: 'what is 2+2'}],
      });
      expect(stderrText()).not.toContain('Auto-resuming');
    });

    it('answers the request still open, not the one already answered', async () => {
      const session = pausedSession('adk_request_input');
      session.events.push(answerEvent('adk_request_input'));
      session.events.push(
        createEvent({
          author: 'step2',
          longRunningToolIds: ['interrupt_456'],
          content: {
            parts: [
              {
                functionCall: {
                  name: 'adk_request_input',
                  id: 'interrupt_456',
                  args: {},
                },
              },
            ],
          },
        }),
      );

      await run({query: 'Paris', sessionId: 'session-1'}, session);

      expect(turns[0].newMessage.parts?.[0].functionResponse).toEqual({
        id: 'interrupt_456',
        name: 'adk_request_input',
        response: {result: 'Paris'},
      });
    });

    it('starts a new turn for a long-running tool that asks nothing', async () => {
      const session = fakeSession('session-1', [
        createEvent({
          author: 'agent',
          longRunningToolIds: ['job_1'],
          content: {
            parts: [
              {functionCall: {name: 'start_backup', id: 'job_1', args: {}}},
            ],
          },
        }),
      ]);

      await run({query: 'is it done?', sessionId: 'session-1'}, session);

      expect(turns[0].newMessage).toEqual({
        role: 'user',
        parts: [{text: 'is it done?'}],
      });
    });

    it('starts a new turn when the session is not paused', async () => {
      const session = fakeSession('session-1', [
        createEvent({author: 'model', content: {parts: [{text: 'Hello'}]}}),
      ]);

      await run({query: 'weather?', sessionId: 'session-1'}, session);

      expect(turns[0].newMessage).toEqual({
        role: 'user',
        parts: [{text: 'weather?'}],
      });
      expect(stderrText()).not.toContain('Auto-resuming');
    });

    it('reuses the named session instead of creating one', async () => {
      await run(
        {query: 'approve', sessionId: 'session-1'},
        pausedSession('adk_request_input'),
      );

      expect(sessionService.created).toHaveLength(0);
      expect(turns[0].sessionId).toBe('session-1');
    });

    it('creates the named session when it does not exist yet', async () => {
      await run({query: 'weather?', sessionId: 'session-2'});

      expect(sessionService.created[0]).toMatchObject({sessionId: 'session-2'});
      expect(turns[0].sessionId).toBe('session-2');
    });
  });

  describe('--replay', () => {
    it('runs every query in the file, in order', async () => {
      (loadFileData as Mock).mockResolvedValue({
        state: {tier: 'gold'},
        queries: ['first', 'second'],
      });

      const code = await run({replay: 'replay.json'});

      expect(code).toBe(0);
      expect(turns.map((turn) => turn.newMessage.parts?.[0].text)).toEqual([
        'first',
        'second',
      ]);
      expect(sessionService.created[0]).toMatchObject({state: {tier: 'gold'}});
    });

    it('ignores --state, since the file carries the state', async () => {
      (loadFileData as Mock).mockResolvedValue({
        state: {tier: 'gold'},
        queries: ['first'],
      });

      const code = await run({replay: 'replay.json', state: 'not-json'});

      expect(code).toBe(0);
      expect(sessionService.created[0]).toMatchObject({state: {tier: 'gold'}});
    });

    it('reports a replay file it cannot read', async () => {
      (loadFileData as Mock).mockResolvedValue(undefined);

      const code = await run({replay: 'missing.json'});

      expect(code).toBe(1);
      expect(stderrText()).toContain(
        'Failed to read the --replay file missing.json.',
      );
    });
  });

  describe('failures', () => {
    it('reports a run that throws', async () => {
      (Runner as unknown as Mock).mockImplementation(() => ({
        // eslint-disable-next-line require-yield -- the Runner contract is an AsyncGenerator, and this turn fails before it emits anything
        runAsync: async function* () {
          throw new Error('the model exploded');
        },
      }));

      const code = await run({query: 'weather?'});

      expect(code).toBe(1);
      expect(stderrText()).toContain('Error: the model exploded');
    });

    it('reports a malformed --timeout', async () => {
      const code = await run({query: 'weather?', timeout: 'soon'});

      expect(code).toBe(1);
      expect(stderrText()).toContain('Error: Invalid timeout format: soon');
    });

    it('aborts a query that overruns its --timeout', async () => {
      const signals: AbortSignal[] = [];
      (Runner as unknown as Mock).mockImplementation(() => ({
        // eslint-disable-next-line require-yield -- the Runner contract is an AsyncGenerator, and this turn is aborted before it emits anything
        runAsync: async function* (params: RecordedTurn) {
          const signal = params.abortSignal;
          if (!signal) {
            expect.fail('the timed query ran without an abort signal');
          }
          signals.push(signal);
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve());
          });
        },
      }));

      // A real one-second deadline, so the abort travels the path it does in
      // a real run.
      const code = await run({query: 'weather?', timeout: '1s'});

      expect(code).toBe(1);
      expect(signals[0].aborted).toBe(true);
      expect(stderrText()).toContain('Error: Command timed out after 1s');
    });
  });

  it('disposes the agent file when the run fails', async () => {
    const dispose = vi.fn();
    (AgentFile as unknown as Mock).mockImplementation(() => ({
      load: vi.fn().mockResolvedValue({name: 'test-agent'} as BaseAgent),
      dispose,
      [Symbol.asyncDispose]: dispose,
    }));

    await run({query: 'weather?', state: 'not-json'});

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
