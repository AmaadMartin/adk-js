/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';
import {Command, Option} from 'commander';
import {runConformanceRecord} from '../conformance/cli_record.js';
import {runConformanceTest} from '../conformance/cli_test.js';
import {
  CONFORMANCE_MODE_VALUES,
  ConformanceStatus,
  ConformanceTestSummary,
  parseConformanceMode,
  parseStreamingMode,
  STREAMING_MODE_VALUES,
} from '../conformance/conformance_types.js';
import {errorMessage} from '../utils/error_utils.js';
import {getAbsolutePath, isFolderExists} from '../utils/file_utils.js';
import {AdkLogger} from '../utils/logger.js';

const logger = new AdkLogger({label: 'Conformance', colorize: {all: true}});

/** Directory searched for test cases when the command gets no path. */
const DEFAULT_TESTS_DIR = 'tests';

const AGENTS_DIR_OPTION = new Option(
  '--agents_dir [dir]',
  'Directory of conformance test agent definitions. Recursively searched for .yaml files with agent definitions.',
).default(process.cwd());

const MODE_OPTION = new Option(
  '--mode <mode>',
  "Test mode: 'replay' verifies against recorded interactions, 'live' runs evaluation-based verification.",
).default(CONFORMANCE_MODE_VALUES[0]);

const GENERATE_REPORT_OPTION = new Option(
  '--generate_report',
  'Optional. Whether to generate a Markdown report of the test results.',
).default(false);

const REPORT_DIR_OPTION = new Option(
  '--report_dir <dir>',
  'Optional. Directory to store the generated report. Defaults to current directory.',
);

/**
 * Spelled with a hyphen, unlike the underscored flags around it, because
 * adk-python spells it `--streaming-mode` and the two CLIs have to accept the
 * same command line. Commander therefore reads it as `streamingMode`.
 */
const STREAMING_MODE_OPTION = new Option(
  '--streaming-mode <mode>',
  `Optional. Which recorded fixture set to replay: ${STREAMING_MODE_VALUES.join(', ')}.`,
);

const FORCE_OPTION = new Option('--force', 'Force run skipped tests.').default(
  false,
);

interface RecordCommandOptions {
  agents_dir: string;
}

interface TestCommandOptions {
  agents_dir: string;
  mode: string;
  generate_report: boolean;
  report_dir?: string;
  /** camelCase because commander derives it from `--streaming-mode`. */
  streamingMode?: string;
  force: boolean;
}

/** Adds the `adk conformance` command group to the program. */
export function registerConformanceCommands(program: Command): void {
  const group = program
    .command('conformance')
    .description('Conformance testing tools for ADK.');

  group
    .command('record')
    .description(
      'Record the conformance fixtures of every test case with a spec.yaml. Each case runs against the model its agent definition names.',
    )
    .usage('[paths...] <streaming_mode> [options]')
    .argument(
      '[args...]',
      `Zero or more directories containing test cases, followed by the streaming mode (${STREAMING_MODE_VALUES.join(', ')}). Directories default to ./${DEFAULT_TESTS_DIR}.`,
    )
    .addOption(AGENTS_DIR_OPTION)
    .action(
      async (
        args: string[],
        options: RecordCommandOptions,
        command: Command,
      ) => {
        const {streamingMode, paths} = parseRecordArgs(args, command);
        const testPaths = await resolveTestPaths(paths, command);

        await runOrExitNonZero(() =>
          runConformanceRecord({
            testPaths,
            streamingMode,
            agentsDir: getAbsolutePath(options.agents_dir),
          }),
        );
      },
    );

  group
    .command('test')
    .description(
      'Run the conformance test cases under the given directories, or under ./tests.',
    )
    .argument(
      '[paths...]',
      `Directories containing test cases. Defaults to ./${DEFAULT_TESTS_DIR}.`,
    )
    .addOption(MODE_OPTION)
    .addOption(GENERATE_REPORT_OPTION)
    .addOption(REPORT_DIR_OPTION)
    .addOption(STREAMING_MODE_OPTION)
    .addOption(AGENTS_DIR_OPTION)
    .addOption(FORCE_OPTION)
    .action(
      async (
        paths: string[],
        options: TestCommandOptions,
        command: Command,
      ) => {
        const mode = parseConformanceMode(options.mode);
        if (!mode) {
          command.error(
            `error: invalid --mode '${options.mode}'. Valid values: ${CONFORMANCE_MODE_VALUES.join(', ')}`,
            {exitCode: 2},
          );
        }

        let streamingMode: StreamingMode | undefined;
        if (options.streamingMode !== undefined) {
          streamingMode = parseStreamingMode(options.streamingMode);
          if (!streamingMode) {
            command.error(
              `error: invalid --streaming-mode '${options.streamingMode}'. Valid values: ${STREAMING_MODE_VALUES.join(', ')}`,
              {exitCode: 2},
            );
          }
        }

        const testPaths = await resolveTestPaths(paths, command);

        await runOrExitNonZero(async () => {
          const summary = await runConformanceTest({
            testPaths,
            agentsDir: getAbsolutePath(options.agents_dir),
            mode,
            generateReport: options.generate_report,
            reportDir: options.report_dir
              ? getAbsolutePath(options.report_dir)
              : undefined,
            streamingMode,
            force: options.force,
          });
          reportSummary(summary);
        });
      },
    );
}

/**
 * Splits the positional values of `record` into the test paths and the
 * streaming mode.
 *
 * The streaming mode is the last value, as in adk-python. Commander only
 * allows a variadic argument in last position, so both are declared as one
 * list and split here.
 */
function parseRecordArgs(
  args: string[],
  command: Command,
): {streamingMode: StreamingMode; paths: string[]} {
  const value = args.at(-1);
  if (value === undefined) {
    command.error("error: missing required argument 'streaming_mode'", {
      exitCode: 2,
    });
  }

  const streamingMode = parseStreamingMode(value);
  if (!streamingMode) {
    command.error(
      `error: invalid streaming_mode '${value}'. Valid values: ${STREAMING_MODE_VALUES.join(', ')}`,
      {exitCode: 2},
    );
  }
  return {streamingMode, paths: args.slice(0, -1)};
}

/** Resolves the test directories, defaulting to ./tests when none is given. */
async function resolveTestPaths(
  paths: string[],
  command: Command,
): Promise<string[]> {
  if (paths.length === 0) {
    return [getAbsolutePath(DEFAULT_TESTS_DIR)];
  }

  const resolved: string[] = [];
  for (const testPath of paths) {
    const absolutePath = getAbsolutePath(testPath);
    if (!(await isFolderExists(absolutePath))) {
      command.error(`error: '${testPath}' is not a directory`, {exitCode: 2});
    }
    resolved.push(absolutePath);
  }
  return resolved;
}

/** Reports a failure to the user and leaves a non-zero exit code behind. */
async function runOrExitNonZero(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error: unknown) {
    logger.error(errorMessage(error));
    process.exitCode = 1;
  }
}

function reportSummary(summary: ConformanceTestSummary): void {
  const counts = {
    [ConformanceStatus.PASSED]: 0,
    [ConformanceStatus.FAILED]: 0,
    [ConformanceStatus.SKIPPED]: 0,
  };
  for (const result of summary.results) {
    counts[result.status]++;
    if (result.status === ConformanceStatus.FAILED) {
      logger.error(`FAIL ${result.name}: ${result.error}`);
    }
  }

  logger.info(
    `${counts[ConformanceStatus.PASSED]} passed, ` +
      `${counts[ConformanceStatus.FAILED]} failed, ` +
      `${counts[ConformanceStatus.SKIPPED]} skipped.`,
  );

  if (counts[ConformanceStatus.FAILED] > 0) {
    process.exitCode = 1;
  }
}
