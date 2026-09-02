/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
  DatabaseSessionService,
  FileArtifactService,
  InMemoryArtifactService,
  InMemoryCredentialService,
  InMemoryMemoryService,
  InMemorySessionService,
  LlmAgent,
  VertexAiMemoryBankService,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {createRunContext} from '../../src/cli/run_context.js';
import {AgentFile} from '../../src/utils/agent_loader.js';

vi.mock('../../src/utils/agent_loader.js', () => ({
  AgentFile: vi.fn(),
}));

// Only the memory bank is faked: it would otherwise reach for Vertex AI
// credentials, and its constructor arguments are what these cases assert.
vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  return {...actual, VertexAiMemoryBankService: vi.fn()};
});

/** The agent an `AgentFile` load resolves to; set per test. */
const loaderState = vi.hoisted(() => ({
  loaded: undefined as unknown,
  loadError: undefined as Error | undefined,
}));

describe('createRunContext', () => {
  let agentDir: string;
  let agentPath: string;
  let dispose: Mock;
  const savedEnv = {...process.env};

  const createAgent = (name: string, model?: string) =>
    new LlmAgent({name, model});

  beforeEach(async () => {
    vi.clearAllMocks();
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-run-context-'));
    agentPath = path.join(agentDir, 'agent.ts');
    await fs.writeFile(agentPath, '');
    loaderState.loaded = createAgent('test-agent', 'gemini-2.5-flash');
    loaderState.loadError = undefined;
    dispose = vi.fn();

    (AgentFile as unknown as Mock).mockImplementation(() => ({
      load: vi.fn(async () => {
        if (loaderState.loadError) {
          throw loaderState.loadError;
        }
        return loaderState.loaded;
      }),
      dispose,
      [Symbol.asyncDispose]: dispose,
    }));
  });

  afterEach(async () => {
    process.env = {...savedEnv};
    // A case that made the directory read only cannot be cleaned up until it
    // is writable again.
    await fs.chmod(agentDir, 0o700).catch(() => {});
    await fs.rm(agentDir, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  it('names the app after the root agent and runs as test_user', async () => {
    const context = await createRunContext({agentPath, inMemory: true});

    expect(context.appName).toBe('test-agent');
    expect(context.userId).toBe('test_user');
    expect(context.agentDir).toBe(agentDir);
    expect(context.app).toBeUndefined();
  });

  describe('services', () => {
    it('keeps everything in memory for --in_memory', async () => {
      const context = await createRunContext({agentPath, inMemory: true});

      expect(context.sessionService).toBeInstanceOf(InMemorySessionService);
      expect(context.artifactService).toBeInstanceOf(InMemoryArtifactService);
      expect(context.memoryService).toBeInstanceOf(InMemoryMemoryService);
      await expect(fs.stat(path.join(agentDir, '.adk'))).rejects.toThrow();
    });

    it('always provides a credential service', async () => {
      const context = await createRunContext({agentPath, inMemory: true});

      expect(context.credentialService).toBeInstanceOf(
        InMemoryCredentialService,
      );
    });

    it('persists under .adk by default', async () => {
      const context = await createRunContext({agentPath});

      expect(context.sessionService).toBeInstanceOf(DatabaseSessionService);
      expect(context.artifactService).toBeInstanceOf(FileArtifactService);
      await expect(fs.stat(path.join(agentDir, '.adk'))).resolves.toBeDefined();
    });

    it('stays in memory when local storage is declined', async () => {
      const context = await createRunContext({
        agentPath,
        useLocalStorage: false,
      });

      expect(context.sessionService).toBeInstanceOf(InMemorySessionService);
      expect(context.artifactService).toBeInstanceOf(InMemoryArtifactService);
      await expect(fs.stat(path.join(agentDir, '.adk'))).rejects.toThrow();
    });

    it('prefers an explicit service URI over local storage', async () => {
      const context = await createRunContext({
        agentPath,
        sessionServiceUri: 'memory://',
        artifactServiceUri: 'memory://',
      });

      expect(context.sessionService).toBeInstanceOf(InMemorySessionService);
      expect(context.artifactService).toBeInstanceOf(InMemoryArtifactService);
      await expect(fs.stat(path.join(agentDir, '.adk'))).rejects.toThrow();
    });

    it('prefers an injected service over anything it would build', async () => {
      const sessionService = new InMemorySessionService();

      const context = await createRunContext({
        agentPath,
        sessionService,
        artifactServiceUri: 'memory://',
        useLocalStorage: false,
      });

      expect(context.sessionService).toBe(sessionService);
    });

    it.each([
      ['agentengine://123', '123'],
      ['agentengine://projects/p/locations/l/reasoningEngines/123', '123'],
    ])('builds a memory bank from %s', async (uri, agentEngineId) => {
      const context = await createRunContext({
        agentPath,
        memoryServiceUri: uri,
        useLocalStorage: false,
      });

      expect(VertexAiMemoryBankService).toHaveBeenCalledWith({agentEngineId});
      expect(context.memoryService).toBeInstanceOf(VertexAiMemoryBankService);
    });

    it('uses the in-memory memory service for memory://', async () => {
      const context = await createRunContext({
        agentPath,
        memoryServiceUri: 'memory://',
        useLocalStorage: false,
      });

      expect(context.memoryService).toBeInstanceOf(InMemoryMemoryService);
    });

    it('rejects an unknown memory service scheme without echoing the URI', async () => {
      await expect(
        createRunContext({
          agentPath,
          memoryServiceUri: 'redis://user:secret@localhost:6379/0',
          useLocalStorage: false,
        }),
      ).rejects.toThrow('Unsupported memory service URI scheme: redis');
      await expect(
        createRunContext({
          agentPath,
          memoryServiceUri: 'redis://user:secret@localhost:6379/0',
          useLocalStorage: false,
        }),
      ).rejects.not.toThrow(/secret/);
    });

    it('rejects a memory bank URI that names no engine', async () => {
      await expect(
        createRunContext({
          agentPath,
          memoryServiceUri: 'agentengine://',
          useLocalStorage: false,
        }),
      ).rejects.toThrow('Missing agent engine id');
    });

    it('disposes the agent file when the services cannot be built', async () => {
      await expect(
        createRunContext({
          agentPath,
          memoryServiceUri: 'redis://localhost',
          useLocalStorage: false,
        }),
      ).rejects.toThrow();

      expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('disposes the agent file when the agent cannot be loaded', async () => {
      loaderState.loadError = new Error('agent file is broken');

      await expect(createRunContext({agentPath})).rejects.toThrow(
        'agent file is broken',
      );

      expect(dispose).toHaveBeenCalledTimes(1);
    });
  });

  it('names the app after the App when the file exports one', async () => {
    const rootAgent = createAgent('root', 'gemini-2.5-flash');
    loaderState.loaded = new App({name: 'weather_app', rootAgent});

    const context = await createRunContext({agentPath, inMemory: true});

    expect(context.appName).toBe('weather_app');
    expect(context.app?.name).toBe('weather_app');
    expect(context.rootAgent).toBe(rootAgent);
  });

  it('falls back to memory when the agent directory is read only', async () => {
    await fs.chmod(agentDir, 0o500);

    const context = await createRunContext({agentPath});

    expect(context.sessionService).toBeInstanceOf(InMemorySessionService);
    expect(context.artifactService).toBeInstanceOf(InMemoryArtifactService);
  });

  it('names no scheme when the memory service URI has none', async () => {
    await expect(
      createRunContext({
        agentPath,
        memoryServiceUri: 'not-a-uri',
        useLocalStorage: false,
      }),
    ).rejects.toThrow(
      'Unsupported memory service URI scheme: <scheme-missing>',
    );
  });

  it('accepts a root that has no sub-agents to walk', async () => {
    loaderState.loaded = {name: 'workflow-root'};

    const context = await createRunContext({
      agentPath,
      inMemory: true,
      defaultLlmModel: 'gemini-2.5-flash',
    });

    expect(context.appName).toBe('workflow-root');
  });

  describe('--default_llm_model', () => {
    it('gives a model to an agent that declares none', async () => {
      const rootAgent = createAgent('modelless');
      loaderState.loaded = rootAgent;

      await createRunContext({
        agentPath,
        inMemory: true,
        defaultLlmModel: 'gemini-2.5-flash',
      });

      expect(rootAgent.model).toBe('gemini-2.5-flash');
    });

    it('leaves an agent that declares one alone', async () => {
      const rootAgent = createAgent('explicit', 'gemini-2.5-pro');
      loaderState.loaded = rootAgent;

      await createRunContext({
        agentPath,
        inMemory: true,
        defaultLlmModel: 'gemini-2.5-flash',
      });

      expect(rootAgent.model).toBe('gemini-2.5-pro');
    });

    it('leaves a sub-agent that inherits a model alone', async () => {
      const subAgent = createAgent('child');
      const rootAgent = new LlmAgent({
        name: 'parent',
        model: 'gemini-2.5-pro',
        subAgents: [subAgent],
      });
      loaderState.loaded = rootAgent;

      await createRunContext({
        agentPath,
        inMemory: true,
        defaultLlmModel: 'gemini-2.5-flash',
      });

      expect(subAgent.model).toBeUndefined();
    });

    it('gives a model to a sub-agent whose parent has none either', async () => {
      const subAgent = createAgent('child');
      const rootAgent = new LlmAgent({
        name: 'parent',
        subAgents: [subAgent],
      });
      loaderState.loaded = rootAgent;

      await createRunContext({
        agentPath,
        inMemory: true,
        defaultLlmModel: 'gemini-2.5-flash',
      });

      // The parent now supplies the model the child inherits, so only the
      // parent is written to.
      expect(rootAgent.model).toBe('gemini-2.5-flash');
      expect(subAgent.model).toBeUndefined();
    });

    it('leaves every model alone when no default is given', async () => {
      const rootAgent = createAgent('modelless');
      loaderState.loaded = rootAgent;

      await createRunContext({agentPath, inMemory: true});

      expect(rootAgent.model).toBeUndefined();
    });
  });

  describe('.env', () => {
    it('applies the file next to the agent', async () => {
      await fs.writeFile(path.join(agentDir, '.env'), 'ADK_TEST_FROM_FILE=1\n');

      await createRunContext({agentPath, inMemory: true});

      expect(process.env['ADK_TEST_FROM_FILE']).toBe('1');
    });

    it('keeps a variable the environment already set', async () => {
      process.env['ADK_TEST_EXPLICIT'] = 'from-shell';
      await fs.writeFile(
        path.join(agentDir, '.env'),
        'ADK_TEST_EXPLICIT=from-file\n',
      );

      await createRunContext({agentPath, inMemory: true});

      expect(process.env['ADK_TEST_EXPLICIT']).toBe('from-shell');
    });

    it('skips the file when ADK_DISABLE_LOAD_DOTENV is on', async () => {
      process.env['ADK_DISABLE_LOAD_DOTENV'] = '1';
      await fs.writeFile(path.join(agentDir, '.env'), 'ADK_TEST_SKIPPED=1\n');

      await createRunContext({agentPath, inMemory: true});

      expect(process.env['ADK_TEST_SKIPPED']).toBeUndefined();
    });

    it('walks up to the nearest file above the agent', async () => {
      const nested = path.join(agentDir, 'nested');
      await fs.mkdir(nested);
      const nestedAgent = path.join(nested, 'agent.ts');
      await fs.writeFile(nestedAgent, '');
      await fs.writeFile(path.join(agentDir, '.env'), 'ADK_TEST_PARENT=1\n');

      await createRunContext({agentPath: nestedAgent, inMemory: true});

      expect(process.env['ADK_TEST_PARENT']).toBe('1');
    });

    it('applies the file before it builds a service', async () => {
      await fs.writeFile(path.join(agentDir, '.env'), 'ADK_TEST_ORDERING=1\n');
      const seenWhileBuilding: Array<string | undefined> = [];
      (VertexAiMemoryBankService as unknown as Mock).mockImplementation(() => {
        seenWhileBuilding.push(process.env['ADK_TEST_ORDERING']);
        return {};
      });

      await createRunContext({
        agentPath,
        memoryServiceUri: 'agentengine://123',
        useLocalStorage: false,
      });

      // A service built before the file is applied reads an unset variable,
      // which is the ordering this pins.
      expect(seenWhileBuilding).toEqual(['1']);
    });
  });
});
