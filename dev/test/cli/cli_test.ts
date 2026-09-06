/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DatabaseSessionService,
  FeatureName,
  FileArtifactService,
  getSessionServiceFromUri,
  InMemoryArtifactService,
  InMemoryMemoryService,
  InMemorySessionService,
  isFeatureEnabled,
  LogLevel,
  overrideFeatureEnabled,
  setLogLevel,
} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
import {createProgram} from '../../src/cli/cli.js';
import {createAgent} from '../../src/cli/cli_create.js';
import {runEvalCli} from '../../src/cli/cli_eval.js';
import {runAgent, runOnceCli} from '../../src/cli/cli_run.js';
import {maybePromptForTelemetryConsent} from '../../src/cli/cli_telemetry.js';
import {deployToAgentEngine} from '../../src/cli/deploy/cli_deploy_agent_engine.js';
import {deployToCloudRun} from '../../src/cli/deploy/cli_deploy_cloud_run.js';
import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {loadDotenvForAgent} from '../../src/utils/envs.js';

vi.mock('../../src/utils/envs.js', () => ({
  loadDotenvForAgent: vi.fn(),
  loadDotenvFromCwd: vi.fn(),
}));

vi.mock('../../src/server/adk_api_server', () => {
  return {
    AdkApiServer: vi.fn(() => ({
      start: vi.fn(),
    })),
  };
});

vi.mock('../../src/cli/cli_create', () => ({
  createAgent: vi.fn(),
}));

vi.mock('../../src/cli/deploy/cli_deploy_agent_engine', () => ({
  deployToAgentEngine: vi.fn(),
}));

vi.mock('../../src/cli/deploy/cli_deploy_cloud_run', () => ({
  deployToCloudRun: vi.fn(),
}));

vi.mock('../../src/cli/cli_run', () => ({
  runAgent: vi.fn(),
  runOnceCli: vi.fn(),
}));

vi.mock('../../src/cli/cli_eval', () => ({
  runEvalCli: vi.fn(),
}));

vi.mock('../../src/cli/cli_telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/cli/cli_telemetry.js')>()),
  maybePromptForTelemetryConsent: vi.fn(),
}));

vi.mock('../../src/version', () => ({
  version: '1.0.0-test',
}));

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  return {
    ...(actual as object),
    setLogLevel: vi.fn(),
    // The storage tests below assert on the services this builds, so the mock
    // keeps the real behaviour. Only the ordering test replaces it, for one
    // call.
    getSessionServiceFromUri: vi.fn(actual.getSessionServiceFromUri),
  };
});

/**
 * The options the mocked AdkApiServer constructor was called with. `vi.mocked`
 * keeps the real constructor's parameter type, so a missing or misspelled
 * server option is a compile error rather than a silent `undefined`.
 */
function serverOptions() {
  return vi.mocked(AdkApiServer).mock.calls[0][0];
}

describe('CLI Entrypoint', () => {
  let program: ReturnType<typeof createProgram>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Local storage is the default now, so a bare `web` would write a .adk
    // directory into the repository. The storage behaviour itself is covered
    // by the "local storage" block below, against a temporary directory.
    process.env['ADK_DISABLE_LOCAL_STORAGE'] = '1';
    program = createProgram();
    program.exitOverride();
  });

  afterEach(() => {
    delete process.env['ADK_DISABLE_LOCAL_STORAGE'];
    vi.restoreAllMocks();
  });

  const parse = async (args: string[]) => {
    try {
      process.argv = args;
      await program.parseAsync(['node', 'cli_entrypoint.js', ...args]);
    } catch (e: unknown) {
      if ((e as {code: string}).code !== 'commander.exit') {
        throw e;
      }
    }
  };

  describe('command: version', () => {
    it('should output version', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await parse(['--version']);
      expect(logSpy).toHaveBeenCalledWith('1.0.0-test');

      await parse(['-v']);
      expect(logSpy).toHaveBeenCalledWith('1.0.0-test');
    });
  });

  describe('command: web', () => {
    it('should start AdkApiServer with default options', async () => {
      await parse(['web']);

      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.INFO);
      // Verify AdkApiServer called. Since we mock it, we can check.
      expect(AdkApiServer).toHaveBeenCalled();
      const args = (AdkApiServer as unknown as Mock).mock.calls[0]?.[0];
      expect(args).toBeDefined();
      expect(args.port).toBe(8000);
      expect(args.serveDebugUI).toBe(true);
      expect(args.a2a).toBe(false);

      // Verify start() called
      const instance = (AdkApiServer as unknown as Mock).mock.results[0].value;
      expect(instance.start).toHaveBeenCalled();
    });

    it('should pass defaultLlmModel when --default_llm_model is set', async () => {
      await parse(['web', '--default_llm_model', 'gemini-2.5-flash']);

      const args = vi.mocked(AdkApiServer).mock.calls[0][0];
      expect(args.defaultLlmModel).toBe('gemini-2.5-flash');
    });

    it('honours --log_level debug', async () => {
      // LogLevel.DEBUG is 0, so the previous `|| LogLevel.INFO` fallback
      // discarded it and the flag did nothing.
      await parse(['web', '--log_level', 'debug']);
      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.DEBUG);
    });

    it('falls back to INFO for an unrecognised --log_level', async () => {
      await parse(['web', '--log_level', 'not-a-level']);
      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.INFO);
    });

    it('should pass options to AdkApiServer', async () => {
      await parse([
        'web',
        '--host',
        '0.0.0.0',
        '--port',
        '9090',
        '--verbose',
        '--allow_origins',
        'http://example.com',
        '--otel_to_cloud',
      ]);

      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.DEBUG);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args).toMatchObject({
        host: '0.0.0.0',
        port: 9090,
        serveDebugUI: true,
        allowOrigins: 'http://example.com',
        otelToCloud: true,
      });
    });

    it('should handle artifact service uri', async () => {
      await parse(['web', '--artifact_service_uri', 'gs://my-bucket']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.artifactService).toBeDefined();
    });

    it('should start AdkApiServer with a2a: true when --a2a is set', async () => {
      await parse(['web', '--a2a']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.a2a).toBe(true);
    });

    it('should start AdkApiServer with a2a: true when --a2a true is set', async () => {
      await parse(['web', '--a2a', 'true']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.a2a).toBe(true);
    });

    it('should pass a2aAuthToken when --a2a_auth_token is set', async () => {
      await parse(['web', '--a2a', '--a2a_auth_token', 'tok']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.a2aAuthToken).toBe('tok');
    });

    it('should pass urlPrefix when --url_prefix is set', async () => {
      await parse(['web', '--url_prefix', '/adk']);

      const args = vi.mocked(AdkApiServer).mock.calls[0][0];
      expect(args.urlPrefix).toBe('/adk');
    });

    it('should leave urlPrefix unset when --url_prefix is absent', async () => {
      await parse(['web']);

      const args = vi.mocked(AdkApiServer).mock.calls[0][0];
      expect(args.urlPrefix).toBeUndefined();
    });

    it('should reject --auto_create_session, which api_server owns', async () => {
      // adk-python declares --auto_create_session on api_server only, so web
      // must not silently accept it.
      const web = program.commands.find((command) => command.name() === 'web')!;
      web.exitOverride();
      web.configureOutput({writeErr: () => {}});

      await expect(
        parse(['web', '--auto_create_session']),
      ).rejects.toMatchObject({code: 'commander.unknownOption'});
      expect(AdkApiServer).not.toHaveBeenCalled();
    });

    it('leaves the trigger options undefined when the flags are absent', async () => {
      await parse(['web']);

      const args = serverOptions();
      expect(args.triggerSources).toBeUndefined();
      expect(args.triggerOidcAudience).toBeUndefined();
      expect(args.triggerOidcServiceAccounts).toBeUndefined();
    });

    it('should split --trigger_sources on commas', async () => {
      await parse(['web', '--trigger_sources', 'pubsub, eventarc,']);

      const args = serverOptions();
      expect(args.triggerSources).toEqual(['pubsub', 'eventarc']);
    });

    it('should pass the trigger OIDC options', async () => {
      await parse([
        'web',
        '--trigger_sources',
        'pubsub',
        '--trigger_oidc_audience',
        'https://svc.example.run.app',
        '--trigger_oidc_service_accounts',
        'a@project.iam, b@project.iam',
      ]);

      const args = serverOptions();
      expect(args.triggerOidcAudience).toBe('https://svc.example.run.app');
      expect(args.triggerOidcServiceAccounts).toEqual([
        'a@project.iam',
        'b@project.iam',
      ]);
    });
  });

  describe('command: api_server', () => {
    it('should start AdkApiServer with serveDebugUI: false', async () => {
      await parse(['api_server']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.serveDebugUI).toBe(false);
      expect(args.a2a).toBe(false);

      const instance = (AdkApiServer as unknown as Mock).mock.results[0].value;
      expect(instance.start).toHaveBeenCalled();
    });

    it('should start AdkApiServer with a2a: true when --a2a is set', async () => {
      await parse(['api_server', '--a2a']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.a2a).toBe(true);
    });

    it('should pass a2aAuthToken when --a2a_auth_token is set', async () => {
      await parse(['api_server', '--a2a', '--a2a_auth_token', 'tok']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.a2aAuthToken).toBe('tok');
    });

    it('should pass urlPrefix when --url_prefix is set', async () => {
      await parse(['api_server', '--url_prefix', '/adk']);

      const args = vi.mocked(AdkApiServer).mock.calls[0][0];
      expect(args.urlPrefix).toBe('/adk');
    });

    it('should pass autoCreateSession when --auto_create_session is set', async () => {
      await parse(['api_server', '--auto_create_session']);

      const args = vi.mocked(AdkApiServer).mock.calls[0][0];
      expect(args.autoCreateSession).toBe(true);
    });

    it('should default autoCreateSession to false', async () => {
      await parse(['api_server']);

      const args = vi.mocked(AdkApiServer).mock.calls[0][0];
      expect(args.autoCreateSession).toBe(false);
    });

    it('leaves the trigger options undefined when the flags are absent', async () => {
      await parse(['api_server']);

      const args = serverOptions();
      expect(args.triggerSources).toBeUndefined();
      expect(args.triggerOidcAudience).toBeUndefined();
      expect(args.triggerOidcServiceAccounts).toBeUndefined();
    });

    it('should split --trigger_sources on commas', async () => {
      await parse(['api_server', '--trigger_sources', 'pubsub,eventarc']);

      const args = serverOptions();
      expect(args.triggerSources).toEqual(['pubsub', 'eventarc']);
    });

    it('should pass the trigger OIDC options', async () => {
      await parse([
        'api_server',
        '--trigger_sources',
        'pubsub',
        '--trigger_oidc_audience',
        'https://svc.example.run.app',
        '--trigger_oidc_service_accounts',
        'a@project.iam',
      ]);

      const args = serverOptions();
      expect(args.triggerOidcAudience).toBe('https://svc.example.run.app');
      expect(args.triggerOidcServiceAccounts).toEqual(['a@project.iam']);
    });

    it('should pass defaultLlmModel when --default_llm_model is set', async () => {
      await parse(['api_server', '--default_llm_model', 'gemini-2.5-flash']);

      const args = serverOptions();
      expect(args.defaultLlmModel).toBe('gemini-2.5-flash');
    });

    it('should leave defaultLlmModel unset without the flag', async () => {
      await parse(['api_server']);

      const args = serverOptions();
      expect(args.defaultLlmModel).toBeUndefined();
    });
  });

  describe('command: create', () => {
    it('should call createAgent with default args', async () => {
      await parse(['create']);

      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'adk_agent',
          forceYes: false,
        }),
      );
    });

    it('should call createAgent with provided args', async () => {
      await parse([
        'create',
        'my-agent',
        '--yes',
        '--model',
        'gemini-pro',
        '--api_key',
        'key',
        '--project',
        'proj',
        '--region',
        'us-central1',
        '--language',
        'ts',
      ]);

      expect(createAgent).toHaveBeenCalledWith({
        agentName: 'my-agent',
        forceYes: true,
        model: 'gemini-pro',
        apiKey: 'key',
        project: 'proj',
        region: 'us-central1',
        language: 'ts',
      });
    });
  });

  describe('command: run', () => {
    it('exits non-zero when the run fails', async () => {
      (runAgent as Mock).mockRejectedValueOnce(
        new Error('Agent file /nope/agent.ts does not exists'),
      );
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as never);

      await parse(['run', '/nope/agent.ts']);

      expect(exit).toHaveBeenCalledWith(1);
    });

    it('should call runAgent with required args', async () => {
      await parse(['run', 'agent.ts']);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentPath: 'agent.ts',
          saveSession: false,
          otelToCloud: false,
        }),
      );
    });

    it.each([
      ['before the path', ['run', '--verbose', 'agent.ts']],
      ['after the path', ['run', 'agent.ts', '--verbose']],
    ])('takes --verbose %s', async (_name, args) => {
      await parse(args);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({agentPath: 'agent.ts'}),
      );
      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.DEBUG);
    });

    it('should pass all options to runAgent', async () => {
      await parse([
        'run',
        'agent.ts',
        '--save_session',
        '--session_id',
        'sess-123',
        '--replay',
        'replay.json',
        '--otel_to_cloud',
      ]);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentPath: 'agent.ts',
          saveSession: true,
          sessionId: 'sess-123',
          inputFile: 'replay.json',
          otelToCloud: true,
        }),
      );
    });

    it('forwards --default_llm_model to runAgent', async () => {
      await parse([
        'run',
        'agent.ts',
        '--default_llm_model',
        'gemini-2.5-flash',
      ]);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({defaultLlmModel: 'gemini-2.5-flash'}),
      );
    });

    it('leaves defaultLlmModel unset without the flag', async () => {
      await parse(['run', 'agent.ts']);

      expect(
        (runAgent as Mock).mock.calls[0][0].defaultLlmModel,
      ).toBeUndefined();
    });

    it('should pass --resume to runAgent as the saved session file', async () => {
      await parse(['run', 'agent.ts', '--resume', 'resume.json']);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({savedSessionFile: 'resume.json'}),
      );
    });

    it("loads the agent's .env before building the session service", async () => {
      // The `.env` may hold the DATABASE_URL the session service is built
      // from, so a load after the service is a load too late.
      const order: string[] = [];
      vi.mocked(loadDotenvForAgent).mockImplementationOnce(() => {
        order.push('dotenv');
      });
      vi.mocked(getSessionServiceFromUri).mockImplementationOnce(() => {
        order.push('session-service');
        return new InMemorySessionService();
      });
      // The URI is what makes the run build a session service at all.
      process.env['DATABASE_URL'] = 'memory://';

      await parse(['run', 'agent.ts']);
      delete process.env['DATABASE_URL'];

      expect(order).toEqual(['dotenv', 'session-service']);
    });

    it("loads the .env of the agent's own directory", async () => {
      const agentPath = path.resolve(
        path.sep,
        'tmp',
        'agents',
        'weather',
        'agent.ts',
      );

      await parse(['run', agentPath]);

      expect(loadDotenvForAgent).toHaveBeenCalledWith(
        'weather',
        path.resolve(path.sep, 'tmp', 'agents'),
      );
    });
  });

  describe('command: run, single-shot mode', () => {
    let exit: MockInstance<typeof process.exit>;

    beforeEach(() => {
      exit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as never);
      vi.mocked(runOnceCli).mockResolvedValue(0);
    });

    it('sends a query to runOnceCli instead of the prompt', async () => {
      await parse(['run', 'agent.ts', 'what is the weather?']);

      expect(runOnceCli).toHaveBeenCalledWith(
        expect.objectContaining({
          agentPath: 'agent.ts',
          query: 'what is the weather?',
        }),
      );
      expect(runAgent).not.toHaveBeenCalled();
    });

    it('forwards the single-shot options', async () => {
      await parse([
        'run',
        'agent.ts',
        'hello',
        '--state',
        '{"city":"Boston"}',
        '--timeout',
        '30s',
        '--jsonl',
        '--session_id',
        'sess-1',
      ]);

      expect(runOnceCli).toHaveBeenCalledWith(
        expect.objectContaining({
          stateStr: '{"city":"Boston"}',
          timeout: '30s',
          jsonl: true,
          sessionId: 'sess-1',
        }),
      );
    });

    it('exits with the code runOnceCli returned', async () => {
      vi.mocked(runOnceCli).mockResolvedValue(2);

      await parse(['run', 'agent.ts', 'hello']);

      expect(exit).toHaveBeenCalledWith(2);
    });

    it('keeps every service in memory under --in_memory', async () => {
      delete process.env['ADK_DISABLE_LOCAL_STORAGE'];

      await parse(['run', 'agent.ts', 'hello', '--in_memory']);

      expect(runOnceCli).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionService: expect.any(InMemorySessionService),
          artifactService: expect.any(InMemoryArtifactService),
          memoryService: expect.any(InMemoryMemoryService),
        }),
      );
    });

    it('opens the prompt when no query is given', async () => {
      await parse(['run', 'agent.ts', '--jsonl', '--state', '{}']);

      expect(runOnceCli).not.toHaveBeenCalled();
      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({jsonl: true, stateStr: '{}'}),
      );
    });
  });

  describe('service URI and local storage options', () => {
    let agentsDir: string;

    beforeEach(() => {
      agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-cli-'));
    });

    afterEach(() => {
      fs.rmSync(agentsDir, {recursive: true, force: true});
    });

    it.each([['web'], ['api_server']])(
      '%s forwards --memory_service_uri',
      async (command) => {
        await parse([command, agentsDir, '--memory_service_uri', 'memory://']);

        const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
        expect(args.memoryService).toBeInstanceOf(InMemoryMemoryService);
      },
    );

    it('run forwards --memory_service_uri', async () => {
      await parse([
        'run',
        path.join(agentsDir, 'agent.ts'),
        '--memory_service_uri',
        'memory://',
      ]);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryService: expect.any(InMemoryMemoryService),
        }),
      );
    });

    it.each([
      ['a successful run', undefined],
      ['a failing run', new Error('agent exploded')],
    ])(
      'run releases the sqlite connection after %s',
      async (_name, failure) => {
        // Without this the sqlite driver keeps the event loop alive and the
        // interactive `adk run` never exits after the user types "exit".
        delete process.env['ADK_DISABLE_LOCAL_STORAGE'];
        const close = vi.spyOn(DatabaseSessionService.prototype, 'close');
        vi.spyOn(process, 'exit').mockImplementation(
          (() => undefined) as never,
        );
        if (failure) {
          vi.mocked(runAgent).mockRejectedValueOnce(failure);
        }

        await parse(['run', path.join(agentsDir, 'agent.ts')]);

        expect(
          vi.mocked(runAgent).mock.calls[0][0].sessionService,
        ).toBeInstanceOf(DatabaseSessionService);
        expect(close).toHaveBeenCalledOnce();
      },
    );

    it('web stores under .adk by default', async () => {
      delete process.env['ADK_DISABLE_LOCAL_STORAGE'];

      await parse(['web', agentsDir]);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.sessionService).toBeInstanceOf(DatabaseSessionService);
      expect(args.artifactService).toBeInstanceOf(FileArtifactService);
      expect(fs.existsSync(path.join(agentsDir, '.adk'))).toBe(true);
    });

    it('web keeps everything in memory under --no_use_local_storage', async () => {
      delete process.env['ADK_DISABLE_LOCAL_STORAGE'];

      await parse(['web', agentsDir, '--no_use_local_storage']);

      const args = (AdkApiServer as unknown as Mock).mock.calls[0][0];
      expect(args.sessionService).toBeInstanceOf(InMemorySessionService);
      expect(args.artifactService).toBeInstanceOf(InMemoryArtifactService);
      expect(fs.existsSync(path.join(agentsDir, '.adk'))).toBe(false);
    });

    it('rejects a storage flag combined with a service URI', async () => {
      const exit = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as never);
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      await parse([
        'web',
        agentsDir,
        '--use_local_storage',
        '--session_service_uri',
        'memory://',
      ]);

      expect(exit).toHaveBeenCalledWith(2);
      expect(stderr.mock.calls.flat().join('')).toContain(
        '--use_local_storage/--no_use_local_storage cannot be used with ' +
          '--session_service_uri or --artifact_service_uri.',
      );
    });

    it('deploy agent_engine forwards the memory URI', async () => {
      await parse([
        'deploy',
        'agent_engine',
        agentsDir,
        '--memory_service_uri',
        'agentengine://123',
      ]);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        memoryServiceUri: 'agentengine://123',
      });
    });
  });

  describe('feature override flags', () => {
    afterEach(() => {
      overrideFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING, undefined);
    });

    it.each([
      ['run', ['run', 'agent.ts']],
      ['web', ['web']],
      ['api_server', ['api_server']],
    ])('%s applies --enable_features', async (_name, args) => {
      await parse([
        ...args,
        `--enable_features=${FeatureName.PROGRESSIVE_SSE_STREAMING}`,
      ]);

      expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(
        true,
      );
    });

    it.each([
      ['run', ['run', 'agent.ts']],
      ['web', ['web']],
      ['api_server', ['api_server']],
    ])('%s applies --disable_features', async (_name, args) => {
      overrideFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING, true);

      await parse([
        ...args,
        `--disable_features=${FeatureName.PROGRESSIVE_SSE_STREAMING}`,
      ]);

      expect(isFeatureEnabled(FeatureName.PROGRESSIVE_SSE_STREAMING)).toBe(
        false,
      );
    });
  });

  describe('command: telemetry', () => {
    it('registers the group and its three subcommands', () => {
      const telemetry = program.commands.find(
        (command) => command.name() === 'telemetry',
      );

      expect(telemetry?.description()).toBe('Manage telemetry settings');
      expect(
        telemetry?.commands.map((command) => command.name()).sort(),
      ).toEqual(['disable', 'enable', 'status']);
    });

    it('asks for consent before another subcommand runs', async () => {
      await parse(['web']);

      expect(maybePromptForTelemetryConsent).toHaveBeenCalledWith(
        'web',
        process.argv,
      );
    });
  });

  describe('command: deploy cloud_run', () => {
    it('should call deployToCloudRun with defaults', async () => {
      await parse(['deploy', 'cloud_run']);

      expect(deployToCloudRun).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 8000,
          serviceName: 'adk-default-service-name',
          adkVersion: 'latest',
          withUi: false,
        }),
      );
    });

    it('should leave tempFolder unset so no temp directory is created eagerly', async () => {
      await parse(['deploy', 'cloud_run']);

      expect(
        (deployToCloudRun as Mock).mock.calls[0][0].tempFolder,
      ).toBeUndefined();
    });

    it('should pass args to deployToCloudRun including unknowns', async () => {
      const args = [
        'deploy',
        'cloud_run',
        './my-agent-path',
        '--port=8080',
        '--project=my-proj',
        '--region=us-west1',
        '--service_name=my-service',
        '--with_ui',
        '--adk_version=1.0.0',
        '--extra-arg=foo',
      ];

      try {
        await parse(args);
      } catch (e) {
        console.log(e);
      }

      expect((deployToCloudRun as Mock).mock.calls[0][0]).toMatchObject({
        agentPath: expect.stringContaining('my-agent-path'),
        project: 'my-proj',
        region: 'us-west1',
        serviceName: 'my-service',
        port: 8080,
        withUi: true,
        adkVersion: '1.0.0',
        extraGcloudArgs: ['--extra-arg=foo'],
      });
    });

    it('should pass a2a flag to deployToCloudRun when --a2a is set', async () => {
      await parse(['deploy', 'cloud_run', '--a2a']);

      expect((deployToCloudRun as Mock).mock.calls[0][0]).toMatchObject({
        a2a: true,
      });
    });

    it('should pass a2aAuthToken to deployToCloudRun when --a2a_auth_token is set', async () => {
      await parse([
        'deploy',
        'cloud_run',
        './my-agent-path',
        '--project=my-proj',
        '--region=us-west1',
        '--a2a',
        '--a2a_auth_token=tok',
      ]);

      const args = (deployToCloudRun as Mock).mock.calls[0][0];
      expect(args).toMatchObject({a2a: true, a2aAuthToken: 'tok'});
      // A recognised flag must not also be passed through as an unknown one,
      // which gcloud would reject.
      expect(args.extraGcloudArgs).toEqual([]);
    });
  });

  describe('command: deploy agent_engine', () => {
    it('should call deployToAgentEngine with defaults', async () => {
      await parse(['deploy', 'agent_engine']);

      expect(deployToAgentEngine).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 8080,
          adkVersion: 'latest',
          withUi: false,
        }),
      );
    });

    it('should leave tempFolder unset so no temp directory is created eagerly', async () => {
      await parse(['deploy', 'agent_engine']);

      expect(
        (deployToAgentEngine as Mock).mock.calls[0][0].tempFolder,
      ).toBeUndefined();
    });

    it('should pass args to deployToAgentEngine', async () => {
      const args = [
        'deploy',
        'agent_engine',
        './my-agent-path',
        '--project=my-proj',
        '--region=us-west1',
        '--display_name=my-display-name',
        '--description=my-description',
        '--with_ui',
        '--adk_version=1.0.0',
      ];

      await parse(args);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        agentPath: expect.stringContaining('my-agent-path'),
        project: 'my-proj',
        region: 'us-west1',
        displayName: 'my-display-name',
        description: 'my-description',
        port: 8080,
        withUi: true,
        adkVersion: '1.0.0',
      });
    });

    it('should pass a2a flag to deployToAgentEngine when --a2a is set', async () => {
      await parse(['deploy', 'agent_engine', '--a2a']);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        a2a: true,
      });
    });

    it('should pass agent_engine_id to deployToAgentEngine when --agent_engine_id is set', async () => {
      await parse(['deploy', 'agent_engine', '--agent_engine_id', '12345']);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        agentEngineId: '12345',
      });
    });
  });

  describe('command: deploy reasoning_engine', () => {
    it('should call deployToAgentEngine for reasoning_engine', async () => {
      await parse(['deploy', 'reasoning_engine']);

      expect(deployToAgentEngine).toHaveBeenCalledWith(
        expect.objectContaining({
          port: 8080,
          adkVersion: 'latest',
          withUi: false,
        }),
      );
    });

    it('should pass agent_engine_id to deployToAgentEngine when --agent_engine_id is set', async () => {
      await parse(['deploy', 'reasoning_engine', '--agent_engine_id', '12345']);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        agentEngineId: '12345',
      });
    });
  });

  describe('mutually exclusive run options', () => {
    it('rejects --replay together with --resume', async () => {
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`exit ${code}`);
      });

      await expect(
        parse(['run', 'agent.ts', '--replay', 'a.json', '--resume', 'b.json']),
      ).rejects.toThrow('exit 1');

      expect(stderr.mock.calls.join('')).toContain(
        "Options 'resume' and 'replay' cannot be set together.",
      );
      expect(exit).toHaveBeenCalledWith(1);
      expect(runAgent).not.toHaveBeenCalled();
      expect(runOnceCli).not.toHaveBeenCalled();
    });

    it('still accepts --replay on its own', async () => {
      await parse(['run', 'agent.ts', '--replay', 'a.json']);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({inputFile: 'a.json'}),
      );
    });
  });

  describe('command: eval', () => {
    it('forwards every option to the eval entry point', async () => {
      await parse([
        'eval',
        'agent.ts',
        'my_set:case1',
        'other_set',
        '--config_file_path',
        'test_config.json',
        '--print_detailed_results',
        '--eval_storage_uri',
        'gs://my-bucket',
        '--log_level',
        'debug',
      ]);

      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.DEBUG);
      expect(runEvalCli).toHaveBeenCalledWith(
        expect.objectContaining({
          agentPath: 'agent.ts',
          evalSetFileOrIds: ['my_set:case1', 'other_set'],
          configFilePath: 'test_config.json',
          printDetailedResults: true,
          evalStorageUri: 'gs://my-bucket',
        }),
      );
    });

    it('defaults the optional eval options', async () => {
      await parse(['eval', 'agent.ts', 'my_set']);

      expect(runEvalCli).toHaveBeenCalledWith(
        expect.objectContaining({
          evalSetFileOrIds: ['my_set'],
          configFilePath: undefined,
          printDetailedResults: false,
          evalStorageUri: undefined,
        }),
      );
    });

    it('exits non-zero when the eval run fails', async () => {
      vi.mocked(runEvalCli).mockRejectedValueOnce(new Error('no eval runtime'));
      const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`exit ${code}`);
      });

      await expect(parse(['eval', 'agent.ts', 'my_set'])).rejects.toThrow(
        'exit 1',
      );

      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
