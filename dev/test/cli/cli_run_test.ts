/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent, BaseSessionService, Runner} from '@google/adk';
import * as readline from 'node:readline';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {runAgent} from '../../src/cli/cli_run.js';
import {AgentFile} from '../../src/utils/agent_loader.js';
import {loadFileData, saveToFile} from '../../src/utils/file_utils.js';

// Mock dependencies
vi.mock('../../src/utils/agent_loader.js', () => ({
  AgentFile: vi.fn(),
}));

vi.mock('../../src/utils/file_utils.js', () => ({
  loadFileData: vi.fn(),
  saveToFile: vi.fn(),
}));

vi.mock('@google/adk', () => {
  return {
    Runner: vi.fn().mockImplementation(() => ({
      runAsync: vi.fn().mockImplementation(async function* () {
        yield {
          author: 'model',
          content: {parts: [{text: 'Response from model'}]},
        };
      }),
    })),
    InMemoryArtifactService: vi.fn(),
    InMemorySessionService: vi.fn().mockImplementation(() => ({
      createSession: vi.fn().mockResolvedValue({
        id: 'session-123',
        appName: 'test-agent',
        userId: 'test_user',
        events: [],
      }),
      appendEvent: vi.fn(),
      getSession: vi.fn().mockResolvedValue({
        id: 'session-123',
        appName: 'test-agent',
        userId: 'test_user',
        events: [],
      }),
    })),
    InMemoryMemoryService: vi.fn(),
    isApp: vi.fn().mockReturnValue(false),
  };
});

vi.mock('node:readline', () => ({
  createInterface: vi.fn(),
}));

/** Listeners registered by `fs.watch`, newest last. */
const watchListeners: Array<() => void | Promise<void>> = [];

// `watch` is a plain function rather than a `vi.fn()` so that the
// `restoreAllMocks()` in `afterEach` cannot strip its implementation.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const watch = (_path: string, listener: () => void | Promise<void>) => {
    watchListeners.push(listener);
    return {close: () => undefined};
  };
  return {...actual, default: {...actual, watch}, watch};
});

describe('cli_run', () => {
  let mockAgentFile: AgentFile;
  let mockRootAgent: BaseAgent;
  let mockRl: readline.Interface;

  beforeEach(() => {
    vi.clearAllMocks();
    watchListeners.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    mockRootAgent = {
      name: 'test-agent',
    } as unknown as BaseAgent;

    mockAgentFile = {
      load: vi.fn().mockResolvedValue(mockRootAgent),
      loadAgent: vi.fn().mockResolvedValue(mockRootAgent),
      [Symbol.asyncDispose]: vi.fn(),
    } as unknown as AgentFile;

    (AgentFile as unknown as Mock).mockImplementation(() => mockAgentFile);

    mockRl = {
      question: vi.fn((query: string, cb: (answer: string) => void) => {
        cb('exit');
      }),
      close: vi.fn(),
    } as unknown as readline.Interface;
    (readline.createInterface as Mock).mockReturnValue(mockRl);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should run interactively by default', async () => {
    await runAgent({agentPath: 'agent.ts'});

    expect(AgentFile).toHaveBeenCalledWith(
      expect.stringContaining('agent.ts'),
      undefined,
    );
    expect(mockAgentFile.load).toHaveBeenCalled();
    expect(readline.createInterface).toHaveBeenCalled();
    expect(mockRl.question).toHaveBeenCalled();
  });

  const createMockSessionService = () =>
    ({
      createSession: vi.fn().mockResolvedValue({
        id: 'session-123',
        appName: 'test-agent',
        userId: 'test_user',
        events: [],
      }),
      appendEvent: vi.fn(),
      getSession: vi.fn().mockResolvedValue({
        id: 'session-123',
        appName: 'test-agent',
        userId: 'test_user',
        events: [],
      }),
    }) as unknown as BaseSessionService;

  it('should rebuild the runner from the reloaded agent file', async () => {
    const reloadedAgent = {name: 'reloaded-agent'} as unknown as BaseAgent;
    const reloadedAgentFile = {
      load: vi.fn().mockResolvedValue(reloadedAgent),
      loadAgent: vi.fn().mockResolvedValue(reloadedAgent),
      [Symbol.asyncDispose]: vi.fn(),
    } as unknown as AgentFile;
    vi.mocked(AgentFile)
      .mockImplementationOnce(() => mockAgentFile)
      .mockImplementationOnce(() => reloadedAgentFile);

    await runAgent({
      agentPath: 'agent.ts',
      reloadAgents: true,
      sessionService: createMockSessionService(),
    });
    const onAgentFileChanged = watchListeners.at(-1);
    if (!onAgentFileChanged) {
      expect.fail('runAgent did not register an fs.watch listener');
    }
    await onAgentFileChanged();

    expect(reloadedAgentFile.loadAgent).toHaveBeenCalled();
    expect(Runner).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agent: reloadedAgent,
        appName: 'reloaded-agent',
      }),
    );
  });

  it('should keep the current runner when the reloaded file fails to load', async () => {
    const failingAgentFile = {
      load: vi.fn(),
      loadAgent: vi.fn().mockRejectedValue(new Error('compile failed')),
      [Symbol.asyncDispose]: vi.fn(),
    } as unknown as AgentFile;
    vi.mocked(AgentFile)
      .mockImplementationOnce(() => mockAgentFile)
      .mockImplementationOnce(() => failingAgentFile);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runAgent({
      agentPath: 'agent.ts',
      reloadAgents: true,
      sessionService: createMockSessionService(),
    });
    const onAgentFileChanged = watchListeners.at(-1);
    if (!onAgentFileChanged) {
      expect.fail('runAgent did not register an fs.watch listener');
    }
    await onAgentFileChanged();

    expect(warn).toHaveBeenCalledWith(
      'Failed to reload agent:',
      'compile failed',
    );
    expect(Runner).toHaveBeenCalledTimes(1);
  });

  it('should run from input file', async () => {
    const inputFileContent = {
      state: {foo: 'bar'},
      queries: ['Hello', 'How are you?'],
    };
    (loadFileData as Mock).mockResolvedValue(inputFileContent);
    const mockSessionService = createMockSessionService();

    await runAgent({
      agentPath: 'agent.ts',
      inputFile: 'input.json',
      sessionService: mockSessionService,
    });

    expect(loadFileData).toHaveBeenCalledWith(
      expect.stringContaining('input.json'),
    );
    expect(mockSessionService.createSession).toHaveBeenCalled();
  });

  it('should handle missing input file', async () => {
    (loadFileData as Mock).mockResolvedValue(null);
    const mockSessionService = createMockSessionService();

    await runAgent({
      agentPath: 'agent.ts',
      inputFile: 'input.json',
      sessionService: mockSessionService,
    });
    expect(loadFileData).toHaveBeenCalled();
  });

  it('should run from saved session', async () => {
    const sessionContent = {
      id: 'old-session',
      appName: 'test-agent',
      userId: 'test_user',
      events: [
        {author: 'user', content: {parts: [{text: 'Hi'}]}},
        {author: 'model', content: {parts: [{text: 'Hello'}]}},
      ],
    };
    (loadFileData as Mock).mockResolvedValue(sessionContent);
    const mockSessionService = createMockSessionService();

    await runAgent({
      agentPath: 'agent.ts',
      savedSessionFile: 'session.json',
      sessionService: mockSessionService,
    });

    expect(loadFileData).toHaveBeenCalledWith('session.json');
    expect(readline.createInterface).toHaveBeenCalled();
  });

  it('should save session when requested', async () => {
    const mockSessionService = createMockSessionService();
    // Run interactively then exit
    await runAgent({
      agentPath: 'agent.ts',
      saveSession: true,
      sessionId: 'my-session',
      sessionService: mockSessionService,
    });

    expect(saveToFile).toHaveBeenCalledWith(
      expect.stringContaining('my-session.session.json'),
      expect.anything(),
    );
  });

  it('should prompt for session id if not provided when saving', async () => {
    (mockRl.question as Mock)
      .mockImplementationOnce((prompt: string, cb: (answer: string) => void) =>
        cb('exit'),
      ) // For the runInteractively loop
      .mockImplementationOnce((prompt: string, cb: (answer: string) => void) =>
        cb('prompted-session-id'),
      ); // For saveSession
    const mockSessionService = createMockSessionService();

    await runAgent({
      agentPath: 'agent.ts',
      saveSession: true,
      sessionService: mockSessionService,
    });

    expect(saveToFile).toHaveBeenCalledWith(
      expect.stringContaining('prompted-session-id.session.json'),
      expect.anything(),
    );
  });
});
