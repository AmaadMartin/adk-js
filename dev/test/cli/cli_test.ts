/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel, setLogLevel} from '@google/adk';
import {Command} from 'commander';
import {Console} from 'node:console';
import {Writable} from 'node:stream';
import {stripVTControlCharacters} from 'node:util';
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
import {runIntegrationTests} from '../../src/integration/run_integration_tests.js';
import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {FileModuleType} from '../../src/utils/agent_loader.js';
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

vi.mock('../../src/integration/run_integration_tests', () => ({
  runIntegrationTests: vi.fn(),
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

/** Command surfaces that register the shared agent-file compilation options. */
const AGENT_FILE_COMMANDS = [
  'web',
  'api_server',
  'run',
  'deploy cloud_run',
  'deploy agent_engine',
  'deploy reasoning_engine',
];

/** Command surfaces that register the shared `--log_level` option. */
const LOG_LEVEL_COMMANDS = [
  'web',
  'api_server',
  'run',
  'deploy cloud_run',
  'deploy agent_engine',
  'deploy reasoning_engine',
  'integration conformance',
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

/** Builds the argv for a command path, including any required positional. */
function argvFor(commandPath: string, ...args: string[]): string[] {
  const positionals = commandPath === 'run' ? ['agent.ts'] : [];
  return [...commandPath.split(' '), ...positionals, ...args];
}

/**
 * Commander copies the exit callback and the output configuration into each
 * subcommand when the subcommand is created, so applying them to the root
 * program after createProgram() has built the tree does not reach the
 * subcommands. Without this, an option validation error raised while parsing a
 * subcommand calls process.exit() and kills the test worker.
 */
function applyExitOverride(command: Command) {
  command.exitOverride().configureOutput({writeErr: () => {}});
  command.commands.forEach(applyExitOverride);
}

/** Asserts that argv parsing failed before any command action was dispatched. */
function expectNoActionRan() {
  expect(AdkApiServer).not.toHaveBeenCalled();
  expect(runAgent).not.toHaveBeenCalled();
  expect(deployToCloudRun).not.toHaveBeenCalled();
  expect(deployToAgentEngine).not.toHaveBeenCalled();
  expect(runIntegrationTests).not.toHaveBeenCalled();
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
  });

  describe('option: --file_type validation', () => {
    beforeEach(() => {
      applyExitOverride(program);
    });

    it.each(AGENT_FILE_COMMANDS)(
      'rejects an out-of-enum --file_type on `%s`',
      async (commandPath) => {
        await expect(
          parse(argvFor(commandPath, '--file_type', 'garbage')),
        ).rejects.toThrow(/Allowed choices are cjs, esm/);

        expectNoActionRan();
      },
    );

    it('reports the rejection as a commander invalid-argument error', async () => {
      await expect(
        parse(['web', '--file_type', 'garbage']),
      ).rejects.toMatchObject({
        code: 'commander.invalidArgument',
        message:
          "error: option '--file_type <string>' argument 'garbage' is invalid. " +
          'Allowed choices are cjs, esm.',
      });
    });

    it('rejects a differently-cased value, as the choices are case-sensitive', async () => {
      await expect(parse(['web', '--file_type', 'CJS'])).rejects.toThrow(
        /argument 'CJS' is invalid/,
      );

      expectNoActionRan();
    });

    it.each([FileModuleType.CJS, FileModuleType.ESM])(
      'accepts --file_type %s and forwards it as moduleType',
      async (moduleType) => {
        await parse(['web', '--file_type', moduleType]);

        const args = vi.mocked(AdkApiServer).mock.calls[0][0];
        expect(args.agentFileLoadOptions).toMatchObject({moduleType});
      },
    );

    it('leaves moduleType undefined when --file_type is omitted', async () => {
      await parse(['web']);

      const args = vi.mocked(AdkApiServer).mock.calls[0][0];
      expect(args.agentFileLoadOptions).toMatchObject({moduleType: undefined});
    });
  });

  describe('option: --log_level validation', () => {
    it.each([
      ['debug', LogLevel.DEBUG],
      ['info', LogLevel.INFO],
      ['warn', LogLevel.WARN],
      ['error', LogLevel.ERROR],
    ])('applies --log_level %s', async (level, expected) => {
      await parse(['web', '--log_level', level]);

      expect(setLogLevel).toHaveBeenCalledWith(expected);
    });

    it.each([
      ['DEBUG', LogLevel.DEBUG],
      ['Warn', LogLevel.WARN],
    ])(
      'accepts --log_level %s regardless of letter case',
      async (level, expected) => {
        await parse(['web', '--log_level', level]);

        expect(setLogLevel).toHaveBeenCalledWith(expected);
      },
    );

    it('normalizes the value handed to the Cloud Run deploy path', async () => {
      await parse(['deploy', 'cloud_run', '--log_level=DEBUG']);

      expect(vi.mocked(deployToCloudRun).mock.calls[0][0]).toMatchObject({
        logLevel: 'debug',
      });
    });

    it.each(LOG_LEVEL_COMMANDS)(
      'lists the accepted levels in `%s` help',
      (commandPath) => {
        const help = findCommand(program, commandPath)
          .helpInformation()
          .replace(/\s+/g, ' ');

        expect(help).toContain(
          '(choices: "debug", "info", "warn", "error", default: "info")',
        );
      },
    );

    describe('rejection', () => {
      beforeEach(() => {
        applyExitOverride(program);
      });

      it.each(LOG_LEVEL_COMMANDS)(
        'rejects an unsupported --log_level on `%s`',
        async (commandPath) => {
          await expect(
            parse(argvFor(commandPath, '--log_level', 'trace')),
          ).rejects.toThrow(/Allowed choices are debug, info, warn, error\./);

          expect(setLogLevel).not.toHaveBeenCalled();
          expectNoActionRan();
        },
      );

      it('reports the rejection as a commander invalid-argument error', async () => {
        await expect(
          parse(['web', '--log_level', 'debbug']),
        ).rejects.toMatchObject({
          code: 'commander.invalidArgument',
          message:
            "error: option '--log_level <string>' argument 'debbug' is invalid. " +
            'Allowed choices are debug, info, warn, error.',
        });
      });

      it('rejects a near-miss level before anything is baked into a deploy', async () => {
        await expect(
          parse(['deploy', 'cloud_run', '--log_level=DEBUG2']),
        ).rejects.toThrow(/Allowed choices are debug, info, warn, error\./);

        expect(deployToCloudRun).not.toHaveBeenCalled();
      });

      it('rejects an empty --log_level', async () => {
        await expect(parse(['web', '--log_level', ''])).rejects.toThrow(
          /Allowed choices are debug, info, warn, error\./,
        );

        expectNoActionRan();
      });

      // The `Object.prototype` keys that survive lower-casing. They would be
      // accepted as levels if the level table were ever a plain object
      // consulted with the `in` operator.
      it.each(['constructor', '__proto__', 'CONSTRUCTOR', '__PROTO__'])(
        'rejects the inherited key --log_level %s',
        async (level) => {
          await expect(parse(['web', '--log_level', level])).rejects.toThrow(
            /Allowed choices are debug, info, warn, error\./,
          );

          expect(setLogLevel).not.toHaveBeenCalled();
          expectNoActionRan();
        },
      );

      it('keeps an inherited key out of the Cloud Run deploy path', async () => {
        await expect(
          parse(['deploy', 'cloud_run', '--log_level=__proto__']),
        ).rejects.toThrow(/Allowed choices are debug, info, warn, error\./);

        expect(deployToCloudRun).not.toHaveBeenCalled();
      });
    });
  });

  describe('option: --verbose', () => {
    it('lets an explicit level win over a following --verbose', async () => {
      await parse(['web', '--log_level', 'error', '--verbose']);

      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.ERROR);
    });

    it('lets an explicit level win over a preceding --verbose', async () => {
      await parse(['web', '--verbose', '--log_level', 'error']);

      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.ERROR);
    });

    it('lets an explicit level win even when it equals the default', async () => {
      await parse(['web', '--log_level', 'info', '--verbose']);

      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.INFO);
    });

    it('keeps debug when the explicit level also asks for debug', async () => {
      await parse(['web', '--log_level', 'debug', '--verbose']);

      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.DEBUG);
    });

    it('lets an explicit level win on api_server', async () => {
      await parse(['api_server', '--log_level', 'warn', '--verbose']);

      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.WARN);
    });

    it('lets an explicit level win on run', async () => {
      await parse(argvFor('run', '--log_level', 'error', '--verbose'));

      expect(setLogLevel).toHaveBeenCalledWith(LogLevel.ERROR);
      expect(runAgent).toHaveBeenCalled();
    });

    it.each([
      [['--verbose'], 'debug'],
      [['--log_level=error', '--verbose'], 'error'],
      [[], 'info'],
    ])(
      'bakes the level resolved from `%s` into the Cloud Run deploy',
      async (flags, logLevel) => {
        await parse(['deploy', 'cloud_run', ...flags]);

        expect(vi.mocked(deployToCloudRun).mock.calls[0][0]).toMatchObject({
          logLevel,
        });
      },
    );

    it.each(['agent_engine', 'reasoning_engine'])(
      'bakes debug into `deploy %s --verbose`',
      async (command) => {
        await parse(['deploy', command, '--verbose']);

        expect(vi.mocked(deployToAgentEngine).mock.calls[0][0]).toMatchObject({
          logLevel: 'debug',
        });
      },
    );

    it('lets an explicit level win on deploy agent_engine', async () => {
      await parse(['deploy', 'agent_engine', '--log_level=warn', '--verbose']);

      expect(vi.mocked(deployToAgentEngine).mock.calls[0][0]).toMatchObject({
        logLevel: 'warn',
      });
    });

    it.each([
      [[], LogLevel.INFO],
      [['--verbose'], LogLevel.DEBUG],
      [['--log_level', 'error', '--verbose'], LogLevel.ERROR],
    ])(
      'applies the resolved level on `integration conformance %s`',
      async (flags, expected) => {
        await parse(['integration', 'conformance', ...flags]);

        expect(setLogLevel).toHaveBeenCalledWith(expected);
        expect(runIntegrationTests).toHaveBeenCalled();
      },
    );

    it.each(LOG_LEVEL_COMMANDS)(
      'documents the shortcut and its precedence in `%s` help',
      (commandPath) => {
        const help = findCommand(program, commandPath)
          .helpInformation()
          .replace(/\s+/g, ' ');

        expect(help).toContain(
          'Enable verbose (DEBUG) logging. Shortcut for --log_level debug; ' +
            'an explicitly passed --log_level wins.',
        );
      },
    );
  });

  describe('log level wiring', () => {
    let setCliLogLevel: MockInstance<AdkLogger['setLogLevel']>;

    beforeEach(() => {
      setCliLogLevel = vi.spyOn(AdkLogger.prototype, 'setLogLevel');
    });

    it.each(LOG_LEVEL_COMMANDS)(
      'applies the debug level to both loggers on `%s --verbose`',
      async (commandPath) => {
        await parse(argvFor(commandPath, '--verbose'));

        expect(setLogLevel).toHaveBeenCalledWith(LogLevel.DEBUG);
        expect(setCliLogLevel).toHaveBeenCalledWith(LogLevel.DEBUG);
      },
    );

    it.each(LOG_LEVEL_COMMANDS)(
      'applies an explicit level to both loggers on `%s --log_level error`',
      async (commandPath) => {
        await parse(argvFor(commandPath, '--log_level', 'error'));

        expect(setLogLevel).toHaveBeenCalledWith(LogLevel.ERROR);
        expect(setCliLogLevel).toHaveBeenCalledWith(LogLevel.ERROR);
      },
    );

    it.each(LOG_LEVEL_COMMANDS)(
      'leaves both loggers at info on `%s` with no flag',
      async (commandPath) => {
        await parse(argvFor(commandPath));

        expect(setLogLevel).toHaveBeenCalledWith(LogLevel.INFO);
        expect(setCliLogLevel).toHaveBeenCalledWith(LogLevel.INFO);
      },
    );

    it('still prints a deploy failure at the strictest selectable level', async () => {
      const written: string[] = [];
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          written.push(String(chunk));
          callback();
        },
      });
      const realConsole = globalThis.console;
      globalThis.console = new Console(sink, sink);
      vi.mocked(deployToCloudRun).mockRejectedValueOnce(
        new Error('permission denied'),
      );

      try {
        await parse(['deploy', 'cloud_run', '--log_level', 'error']);
        // Winston hands a record to its transport asynchronously.
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        globalThis.console = realConsole;
      }

      expect(setCliLogLevel).toHaveBeenCalledWith(LogLevel.ERROR);
      expect(stripVTControlCharacters(written.join(''))).toContain(
        'Error deploying agent: permission denied',
      );
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
