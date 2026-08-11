/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, setLogLevel} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {createProgram} from '../../src/cli/cli.js';
import {createAgent} from '../../src/cli/cli_create.js';
import {runAgent} from '../../src/cli/cli_run.js';
import {deployToAgentEngine} from '../../src/cli/deploy/cli_deploy_agent_engine.js';
import {deployToCloudRun} from '../../src/cli/deploy/cli_deploy_cloud_run.js';
import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {AdkLogger} from '../../src/utils/logger.js';

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

describe('CLI Entrypoint', () => {
  let program: ReturnType<typeof createProgram>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = createProgram();
    program.exitOverride();
  });

  afterEach(() => {
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

  describe('server start-up failure', () => {
    const mockAdkApiServer = AdkApiServer as unknown as Mock;
    let originalExitCode: typeof process.exitCode;

    beforeEach(() => {
      originalExitCode = process.exitCode;
      process.exitCode = 0;
    });

    afterEach(() => {
      process.exitCode = originalExitCode;
    });

    /** Makes the next `AdkApiServer` reject from `start()`; returns its `stop` mock. */
    const rejectNextStart = (
      error: unknown,
      stop = vi.fn().mockResolvedValue(undefined),
    ) => {
      mockAdkApiServer.mockImplementationOnce(() => ({
        start: vi.fn().mockRejectedValue(error),
        stop,
      }));
      return stop;
    };

    const spyOnLoggerError = () =>
      vi.spyOn(AdkLogger.prototype, 'error').mockImplementation(() => {});

    const failIfProcessExits = () =>
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit was called');
      });

    it('should log the reason, stop the server and exit 1 for web', async () => {
      const errorSpy = spyOnLoggerError();
      const exitSpy = failIfProcessExits();
      const stop = rejectNextStart(new Error('Port 8000 is already in use'));

      await parse(['web']);

      expect(errorSpy).toHaveBeenCalledWith(
        'Error starting web server:',
        'Port 8000 is already in use',
      );
      expect(stop).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('should log the reason, stop the server and exit 1 for api_server', async () => {
      const errorSpy = spyOnLoggerError();
      const exitSpy = failIfProcessExits();
      const stop = rejectNextStart(new Error('Port 8000 is already in use'));

      await parse(['api_server']);

      expect(errorSpy).toHaveBeenCalledWith(
        'Error starting API server:',
        'Port 8000 is already in use',
      );
      expect(stop).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('should swallow a stop() rejection from a server that never bound', async () => {
      const errorSpy = spyOnLoggerError();
      rejectNextStart(
        new Error('Port 8000 is already in use'),
        vi.fn().mockRejectedValue(new Error('Server is not running.')),
      );

      await expect(parse(['api_server'])).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        'Error starting API server:',
        'Port 8000 is already in use',
      );
      expect(process.exitCode).toBe(1);
    });

    it('should log a non-Error rejection as its string form', async () => {
      const errorSpy = spyOnLoggerError();
      rejectNextStart('the agent directory does not exist');

      await parse(['web']);

      expect(errorSpy).toHaveBeenCalledWith(
        'Error starting web server:',
        'the agent directory does not exist',
      );
      expect(process.exitCode).toBe(1);
    });

    it('should report a constructor failure with no server to stop', async () => {
      const errorSpy = spyOnLoggerError();
      mockAdkApiServer.mockImplementationOnce(() => {
        throw new Error('bad session service uri');
      });

      await expect(parse(['web'])).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        'Error starting web server:',
        'bad session service uri',
      );
      expect(process.exitCode).toBe(1);
    });

    it('should leave the exit code alone and not stop the server on success', async () => {
      const stop = vi.fn().mockResolvedValue(undefined);
      mockAdkApiServer.mockImplementationOnce(() => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop,
      }));

      await parse(['api_server']);

      expect(process.exitCode).toBe(0);
      expect(stop).not.toHaveBeenCalled();
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
});
