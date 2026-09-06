/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DatabaseSessionService,
  getArtifactServiceFromUri,
  getSessionServiceFromUri,
  InMemoryArtifactService,
  InMemorySessionService,
  LogLevel,
  setLogLevel,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {createProgram} from '../../src/cli/cli.js';
import {createAgent} from '../../src/cli/cli_create.js';
import {runAgent} from '../../src/cli/cli_run.js';
import {deployToAgentEngine} from '../../src/cli/deploy/cli_deploy_agent_engine.js';
import {deployToCloudRun} from '../../src/cli/deploy/cli_deploy_cloud_run.js';
import {AdkApiServer} from '../../src/server/adk_api_server.js';

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
}));

vi.mock('../../src/version', () => ({
  version: '1.0.0-test',
}));

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    setLogLevel: vi.fn(),
  };
});

/** A URI scheme the CLI help text names, with a URI that exercises it. */
interface ServiceUriScheme {
  scheme: string;
  sampleUri: string;
}

/**
 * Schemes named in the session help text. `vertexai://` is routed by the
 * registry but deliberately undocumented, because
 * `core/src/sessions/registry.ts` discards the URI and builds a
 * `VertexAiSessionService` that throws without a project and location.
 */
const SESSION_SERVICE_URI_SCHEMES: ServiceUriScheme[] = [
  {scheme: 'memory://', sampleUri: 'memory://'},
  {scheme: 'postgres://', sampleUri: 'postgres://user:pw@localhost:5432/adk'},
  {
    scheme: 'postgresql://',
    sampleUri: 'postgresql://user:pw@localhost:5432/adk',
  },
  {scheme: 'mysql://', sampleUri: 'mysql://user:pw@localhost:3306/adk'},
  {scheme: 'mariadb://', sampleUri: 'mariadb://user:pw@localhost:3306/adk'},
  {scheme: 'mssql://', sampleUri: 'mssql://user:pw@localhost:1433/adk'},
  {scheme: 'sqlite://', sampleUri: 'sqlite://./adk_sessions.db'},
  {scheme: 'sqlite://:memory:', sampleUri: 'sqlite://:memory:'},
];

/** Schemes named in the artifact help text. */
const ARTIFACT_SERVICE_URI_SCHEMES: ServiceUriScheme[] = [
  {scheme: 'memory://', sampleUri: 'memory://'},
  {scheme: 'gs://', sampleUri: 'gs://my-bucket'},
  {scheme: 'file://', sampleUri: 'file:///tmp/adk-artifacts'},
];

/**
 * Returns the help description registered for `longFlag` on the `web` command.
 *
 * The service URI options are single shared `Option` instances added to every
 * command, so reading `web`'s registration reads the text all five render.
 */
function webOptionDescription(
  program: ReturnType<typeof createProgram>,
  longFlag: string,
): string {
  const web = program.commands.find((command) => command.name() === 'web');
  if (!web) {
    expect.fail('The `web` command is not registered');
  }

  const option = web.options.find((o) => o.long === longFlag);
  if (!option) {
    expect.fail(`The \`web\` command does not register ${longFlag}`);
  }

  return option.description;
}

/** Returns the options the CLI passed to the first `AdkApiServer` it built. */
function servedOptions() {
  return vi.mocked(AdkApiServer).mock.calls[0][0];
}

describe('CLI Entrypoint', () => {
  let program: ReturnType<typeof createProgram>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = createProgram();
    program.exitOverride();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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
        '--resume',
        'resume.json',
        '--otel_to_cloud',
      ]);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentPath: 'agent.ts',
          saveSession: true,
          sessionId: 'sess-123',
          inputFile: 'replay.json',
          savedSessionFile: 'resume.json',
          otelToCloud: true,
        }),
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

  describe('service URI help text', () => {
    it('names only session service URI schemes the registry accepts', () => {
      const description = webOptionDescription(
        program,
        '--session_service_uri',
      );

      for (const {scheme, sampleUri} of SESSION_SERVICE_URI_SCHEMES) {
        expect(description).toContain(scheme);
        expect(() => getSessionServiceFromUri(sampleUri)).not.toThrow();
      }
    });

    it('names only artifact service URI schemes the registry accepts', () => {
      const description = webOptionDescription(
        program,
        '--artifact_service_uri',
      );

      for (const {scheme, sampleUri} of ARTIFACT_SERVICE_URI_SCHEMES) {
        expect(description).toContain(scheme);
        expect(() => getArtifactServiceFromUri(sampleUri)).not.toThrow();
      }
    });

    it('documents the DATABASE_URL fall-back and the memory:// default', () => {
      const description = webOptionDescription(
        program,
        '--session_service_uri',
      );

      expect(description).toContain('DATABASE_URL');
      expect(description).toContain('if that is unset too, memory://');
    });

    it('documents the memory:// default for artifacts', () => {
      const description = webOptionDescription(
        program,
        '--artifact_service_uri',
      );

      expect(description).toContain('If unset, memory://');
    });
  });

  describe('service URI fall-backs', () => {
    it('uses DATABASE_URL when --session_service_uri is omitted', async () => {
      vi.stubEnv('DATABASE_URL', 'sqlite://:memory:');

      await parse(['web']);

      expect(servedOptions().sessionService).toBeInstanceOf(
        DatabaseSessionService,
      );
    });

    it('falls back to an in-memory session service when neither is set', async () => {
      vi.stubEnv('DATABASE_URL', undefined);

      await parse(['web']);

      expect(servedOptions().sessionService).toBeInstanceOf(
        InMemorySessionService,
      );
    });

    it('prefers --session_service_uri over DATABASE_URL', async () => {
      vi.stubEnv('DATABASE_URL', 'sqlite://:memory:');

      await parse(['web', '--session_service_uri', 'memory://']);

      expect(servedOptions().sessionService).toBeInstanceOf(
        InMemorySessionService,
      );
    });

    it('falls back to an in-memory artifact service when the flag is omitted', async () => {
      await parse(['web']);

      expect(servedOptions().artifactService).toBeInstanceOf(
        InMemoryArtifactService,
      );
    });
  });
});
