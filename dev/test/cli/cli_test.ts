/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, setLogLevel} from '@google/adk';
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
import {runAgent} from '../../src/cli/cli_run.js';
import {deployToAgentEngine} from '../../src/cli/deploy/cli_deploy_agent_engine.js';
import {deployToCloudRun} from '../../src/cli/deploy/cli_deploy_cloud_run.js';
import {AdkApiServer} from '../../src/server/adk_api_server.js';

/** Shared so a test can decide how `AdkApiServer.start()` settles. */
const {mockServerStart} = vi.hoisted(() => ({mockServerStart: vi.fn()}));

vi.mock('../../src/server/adk_api_server', () => {
  return {
    AdkApiServer: vi.fn(() => ({
      start: mockServerStart,
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

/** Thrown by the `process.exit` stub so nothing runs past the exit. */
class ProcessExitError extends Error {
  constructor(code: number | string | null | undefined) {
    super(`process.exit(${code})`);
  }
}

type StderrWrite = typeof process.stderr.write;

interface StderrCapture {
  /** Everything written to stderr, in write order. */
  readonly chunks: string[];
  /** Flush callbacks withheld from the writer, in write order. */
  readonly withheldFlushes: Array<() => void>;
  readonly write: StderrWrite;
}

/**
 * Builds a `process.stderr.write` replacement that records what was written.
 *
 * With `holdFlush` the flush callback is withheld instead of invoked, so a test
 * can observe what the CLI does while the write is still in flight.
 */
function captureStderr(holdFlush = false): StderrCapture {
  const chunks: string[] = [];
  const withheldFlushes: Array<() => void> = [];

  const write: StderrWrite = (
    chunk: string | Uint8Array,
    encodingOrCallback?: string | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    chunks.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
    );

    const flush =
      typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
    if (flush) {
      if (holdFlush) {
        withheldFlushes.push(() => flush());
      } else {
        flush();
      }
    }
    return true;
  };

  return {chunks, withheldFlushes, write};
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

    it('should forward --port 0 to AdkApiServer unchanged', async () => {
      await parse(['api_server', '--port', '0']);

      const args = vi.mocked(AdkApiServer).mock.calls[0][0];
      expect(args.port).toBe(0);
    });
  });

  describe('server start-up failure', () => {
    const FAILURE_MESSAGE = 'Port 41234 is already in use';

    let stderr: StderrCapture;
    let exitSpy: MockInstance<typeof process.exit>;

    const stubProcess = (holdFlush = false) => {
      stderr = captureStderr(holdFlush);
      vi.spyOn(process.stderr, 'write').mockImplementation(stderr.write);
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new ProcessExitError(code);
      });
    };

    // Drops a rejection queued by a test that failed before the CLI consumed
    // it, so it cannot leak into the next test.
    afterEach(() => {
      mockServerStart.mockReset();
    });

    const runExpectingExit = async (argv: string[]) => {
      try {
        await program.parseAsync(['node', 'cli_entrypoint.js', ...argv]);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ProcessExitError);
        return;
      }
      expect.fail('the CLI did not exit');
    };

    it('should write the API server failure and its stack to stderr', async () => {
      stubProcess();
      const error = new Error(FAILURE_MESSAGE);
      mockServerStart.mockRejectedValueOnce(error);

      await runExpectingExit(['api_server']);

      const {stack} = error;
      if (!stack) expect.fail('the fixture error carries no stack');
      const written = stderr.chunks.join('');
      expect(written).toContain('[ADK CLI] Error starting API server: ');
      expect(written).toContain(stack);
      expect(written.endsWith('\n')).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should write the web server failure and its stack to stderr', async () => {
      stubProcess();
      const error = new Error(FAILURE_MESSAGE);
      mockServerStart.mockRejectedValueOnce(error);

      await runExpectingExit(['web']);

      const {stack} = error;
      if (!stack) expect.fail('the fixture error carries no stack');
      const written = stderr.chunks.join('');
      expect(written).toContain('[ADK CLI] Error starting web server: ');
      expect(written).toContain(stack);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should exit only once the stderr diagnostic has flushed', async () => {
      stubProcess(true);
      mockServerStart.mockRejectedValueOnce(new Error(FAILURE_MESSAGE));

      const run = runExpectingExit(['api_server']);
      await new Promise((resolve) => setImmediate(resolve));

      expect(stderr.chunks.join('')).toContain(FAILURE_MESSAGE);
      expect(exitSpy).not.toHaveBeenCalled();

      const [flush] = stderr.withheldFlushes;
      if (!flush) expect.fail('the CLI did not write to stderr');
      flush();

      await run;
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should report a rejection value that is not an Error', async () => {
      stubProcess();
      mockServerStart.mockRejectedValueOnce(
        'the agent directory does not exist',
      );

      await runExpectingExit(['api_server']);

      expect(stderr.chunks.join('')).toContain(
        '[ADK CLI] Error starting API server: the agent directory does not exist',
      );
    });

    it('should fall back to the message when the error carries no stack', async () => {
      stubProcess();
      const error = new Error(FAILURE_MESSAGE);
      error.stack = undefined;
      mockServerStart.mockRejectedValueOnce(error);

      await runExpectingExit(['api_server']);

      expect(stderr.chunks.join('')).toContain(
        `[ADK CLI] Error starting API server: ${FAILURE_MESSAGE}\n`,
      );
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
});
