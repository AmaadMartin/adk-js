/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, setLogLevel} from '@google/adk';
import type {Command} from 'commander';
import type {Mock} from 'vitest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createProgram} from '../../src/cli/cli.js';
import {createAgent} from '../../src/cli/cli_create.js';
import {runAgent} from '../../src/cli/cli_run.js';
import {deployToAgentEngine} from '../../src/cli/deploy/cli_deploy_agent_engine.js';
import {deployToCloudRun} from '../../src/cli/deploy/cli_deploy_cloud_run.js';
import {runIntegrationTests} from '../../src/integration/run_integration_tests.js';
import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {AdkLogger, setDefaultLogLevel} from '../../src/utils/logger.js';

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

vi.mock('../../src/integration/run_integration_tests', () => ({
  // The factory-argument fake survives the suite's `vi.restoreAllMocks()`;
  // an implementation installed with `mockResolvedValue` would not.
  runIntegrationTests: vi.fn(async () => 0),
}));

vi.mock('../../src/version', () => ({
  version: '1.0.0-test',
}));

// Only the one export is replaced: AdkLogger stays real for every other
// module the CLI pulls in.
vi.mock('../../src/utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setDefaultLogLevel: vi.fn(),
}));

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    setLogLevel: vi.fn(),
  };
});

/** Command surfaces that register the shared agent-file compilation options. */
const AGENT_FILE_COMMANDS = [
  'web',
  'api_server',
  'run',
  'deploy cloud_run',
  'deploy agent_engine',
  'deploy reasoning_engine',
];

/** Resolves a space-separated command path, e.g. `deploy cloud_run`. */
function findCommand(program: Command, commandPath: string): Command {
  let command = program;
  for (const name of commandPath.split(' ')) {
    const child = command.commands.find((c) => c.name() === name);
    if (!child) {
      expect.fail(`Command "${commandPath}" is not registered`);
    }
    command = child;
  }
  return command;
}

/**
 * Returns the `--file_type` entry of a command's help, whitespace-normalized so
 * assertions are independent of commander's column wrapping.
 */
function fileTypeHelp(program: Command, commandPath: string): string {
  const help = findCommand(program, commandPath)
    .helpInformation()
    .replace(/\s+/g, ' ');
  const entry = help.match(/--file_type <string>.*?(?= --?[a-z])/);
  if (!entry) {
    expect.fail(`"${commandPath}" help does not list --file_type`);
  }
  return entry[0];
}

describe('CLI Entrypoint', () => {
  let program: ReturnType<typeof createProgram>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    program = createProgram();
    program.exitOverride();
    originalExitCode = process.exitCode;
    process.exitCode = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
  });

  const parse = async (args: string[]) => {
    try {
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

  describe('option help text', () => {
    it.each(AGENT_FILE_COMMANDS)(
      'describes what --file_type selects in `%s` help',
      (commandPath) => {
        const entry = fileTypeHelp(program, commandPath);

        expect(entry).not.toMatch(/^--file_type <string> Optional\. \(choices/);
        expect(entry).toContain('.cjs');
        expect(entry).toContain('.mjs');
        expect(entry).toContain('(choices: "cjs", "esm")');
      },
    );

    it.each(AGENT_FILE_COMMANDS)(
      'limits the package.json fallback to .js and .ts in `%s` help',
      (commandPath) => {
        const entry = fileTypeHelp(program, commandPath);

        expect(entry).toContain('extension (.cjs/.cts, .mjs/.mts)');
        expect(entry).toMatch(/nearest package\.json for \.js and \.ts files/);
      },
    );
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

    it('applies the resolved level to the dev loggers', async () => {
      // Without this the dev AdkLogger stays pinned at INFO and every
      // `logger.debug` in the dev package is dead code.
      await parse(['web', '--verbose']);

      expect(setDefaultLogLevel).toHaveBeenCalledWith(LogLevel.DEBUG);
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

    it('should enable otelToCloud when --otel_to_cloud is passed as a bare flag', async () => {
      await parse(['web', '--otel_to_cloud']);

      const args = vi.mocked(AdkApiServer).mock.calls[0][0];
      expect(args.otelToCloud).toBe(true);
    });

    it('should disable otelToCloud when --otel_to_cloud=false', async () => {
      await parse(['web', '--otel_to_cloud=false']);

      const args = vi.mocked(AdkApiServer).mock.calls[0][0];
      expect(args.otelToCloud).toBe(false);
    });
  });

  describe('command: api_server', () => {
    it('applies the resolved level to the dev loggers', async () => {
      await parse(['api_server', '--verbose']);

      expect(setDefaultLogLevel).toHaveBeenCalledWith(LogLevel.DEBUG);
    });

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

    it('should enable otelToCloud when --otel_to_cloud is passed as a bare flag', async () => {
      await parse(['api_server', '--otel_to_cloud']);

      const args = vi.mocked(AdkApiServer).mock.calls[0][0];
      expect(args.otelToCloud).toBe(true);
    });

    it('should disable otelToCloud when --otel_to_cloud=false', async () => {
      await parse(['api_server', '--otel_to_cloud=false']);

      const args = vi.mocked(AdkApiServer).mock.calls[0][0];
      expect(args.otelToCloud).toBe(false);
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

    it('applies the resolved level to the dev loggers', async () => {
      await parse(['run', 'agent.ts', '--log_level', 'error']);

      expect(setDefaultLogLevel).toHaveBeenCalledWith(LogLevel.ERROR);
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

    it('should enable otelToCloud when --otel_to_cloud is passed as a bare flag', async () => {
      await parse(['run', 'agent.ts', '--otel_to_cloud']);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({otelToCloud: true}),
      );
    });

    it('should disable otelToCloud when --otel_to_cloud=false', async () => {
      await parse(['run', 'agent.ts', '--otel_to_cloud=false']);

      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({otelToCloud: false}),
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

      await parse(args);

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

    it('should forward every unknown flag when no agent directory is given', async () => {
      await parse([
        'deploy',
        'cloud_run',
        '--no-allow-unauthenticated',
        '--min-instances=2',
      ]);

      const args = (deployToCloudRun as Mock).mock.calls[0][0];
      expect(args.extraGcloudArgs).toEqual([
        '--no-allow-unauthenticated',
        '--min-instances=2',
      ]);
      expect(args.agentPath).toBe(process.cwd());
    });

    it('should forward every unknown flag exactly once after an agent directory', async () => {
      await parse([
        'deploy',
        'cloud_run',
        './my-agent-path',
        '--project=my-proj',
        '--no-allow-unauthenticated',
        '--min-instances=2',
      ]);

      const args = (deployToCloudRun as Mock).mock.calls[0][0];
      expect(args.extraGcloudArgs).toEqual([
        '--no-allow-unauthenticated',
        '--min-instances=2',
      ]);
      expect(args.agentPath).toContain('my-agent-path');
      expect(args.project).toBe('my-proj');
    });

    it('should forward the value of a space-separated unknown flag', async () => {
      await parse(['deploy', 'cloud_run', '--min-instances', '2']);

      const args = (deployToCloudRun as Mock).mock.calls[0][0];
      expect(args.extraGcloudArgs).toEqual(['--min-instances', '2']);
      expect(args.agentPath).toBe(process.cwd());
    });

    it('should forward args after a -- separator', async () => {
      await parse([
        'deploy',
        'cloud_run',
        './my-agent-path',
        '--',
        '--no-allow-unauthenticated',
      ]);

      const args = (deployToCloudRun as Mock).mock.calls[0][0];
      expect(args.extraGcloudArgs).toEqual(['--no-allow-unauthenticated']);
      expect(args.agentPath).toContain('my-agent-path');
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

    it('should pass staging_bucket to deployToAgentEngine when --staging_bucket is set', async () => {
      await parse(['deploy', 'agent_engine', '--staging_bucket', 'my-bucket']);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        stagingBucket: 'my-bucket',
      });
    });

    it('should leave stagingBucket unset when --staging_bucket is absent', async () => {
      await parse(['deploy', 'agent_engine']);

      expect(
        (deployToAgentEngine as Mock).mock.calls[0][0].stagingBucket,
      ).toBeUndefined();
    });

    it('should not consume the agents_dir positional when --staging_bucket is set', async () => {
      await parse([
        'deploy',
        'agent_engine',
        '--staging_bucket=my-bucket',
        './my-agent-path',
      ]);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        agentPath: expect.stringContaining('my-agent-path'),
        stagingBucket: 'my-bucket',
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

    it('should pass staging_bucket to deployToAgentEngine when --staging_bucket is set', async () => {
      await parse([
        'deploy',
        'reasoning_engine',
        '--staging_bucket',
        'my-bucket',
      ]);

      expect((deployToAgentEngine as Mock).mock.calls[0][0]).toMatchObject({
        stagingBucket: 'my-bucket',
      });
    });
  });

  describe('command: integration conformance', () => {
    it('should pass parsed options to runIntegrationTests', async () => {
      await parse([
        'integration',
        'conformance',
        '--agents_dir',
        '/a',
        '--tests_dir',
        '/t',
        '--force',
      ]);

      expect(runIntegrationTests).toHaveBeenCalledWith({
        agentsDir: '/a',
        testsDir: '/t',
        forceRunAll: true,
      });
    });

    it('should wait for the conformance run before the action resolves', async () => {
      let finishRun!: (failed: number) => void;
      vi.mocked(runIntegrationTests).mockReturnValue(
        new Promise<number>((resolve) => {
          finishRun = resolve;
        }),
      );

      let settled = false;
      const parsed = parse(['integration', 'conformance']).then(() => {
        settled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(settled).toBe(false);

      finishRun(0);
      await parsed;

      expect(settled).toBe(true);
    });

    it('should exit with status 1 when a conformance test failed', async () => {
      vi.mocked(runIntegrationTests).mockResolvedValue(2);

      await parse(['integration', 'conformance']);

      expect(process.exitCode).toBe(1);
    });

    it('should leave the exit code alone when every test passed', async () => {
      vi.mocked(runIntegrationTests).mockResolvedValue(0);

      await parse(['integration', 'conformance']);

      expect(process.exitCode).toBe(0);
    });

    it('should exit with status 1 when the conformance run throws', async () => {
      const errorSpy = vi
        .spyOn(AdkLogger.prototype, 'error')
        .mockImplementation(() => {});
      vi.mocked(runIntegrationTests).mockRejectedValue(new Error('boom'));

      await expect(
        parse(['integration', 'conformance']),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        'Error running conformance tests:',
        'boom',
      );
      expect(process.exitCode).toBe(1);
    });
  });
});
