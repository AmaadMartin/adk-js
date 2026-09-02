/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StreamingMode} from '@google/adk';
import {Command, CommanderError} from 'commander';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createProgram} from '../../src/cli/cli.js';
import {runConformanceRecord} from '../../src/conformance/cli_record.js';
import {runConformanceTest} from '../../src/conformance/cli_test.js';
import {ConformanceStatus} from '../../src/conformance/conformance_types.js';
import {runIntegrationTests} from '../../src/integration/run_integration_tests.js';

vi.mock('../../src/conformance/cli_record', () => ({
  runConformanceRecord: vi.fn(),
}));

vi.mock('../../src/conformance/cli_test', () => ({
  runConformanceTest: vi.fn(),
}));

vi.mock('../../src/integration/run_integration_tests', () => ({
  runIntegrationTests: vi.fn(),
}));

const EXISTING_DIR = 'dev/test';
const OTHER_EXISTING_DIR = 'dev/src';

function absolute(relativePath: string): string {
  return path.resolve(process.cwd(), relativePath);
}

const recordMock = vi.mocked(runConformanceRecord);
const testMock = vi.mocked(runConformanceTest);

describe('command: conformance', () => {
  let program: Command;
  let stderr: string;
  let previousExitCode: number | string | undefined;

  function applyTestOutput(command: Command) {
    command.exitOverride();
    command.configureOutput({
      writeOut: () => {},
      writeErr: (message: string) => {
        stderr += message;
      },
    });
    for (const subcommand of command.commands) {
      applyTestOutput(subcommand);
    }
  }

  /** Runs the CLI and returns the exit error commander raised, if any. */
  async function parse(args: string[]): Promise<CommanderError | undefined> {
    try {
      await program.parseAsync(args, {from: 'user'});
      return undefined;
    } catch (error: unknown) {
      if (error instanceof CommanderError) {
        return error;
      }
      throw error;
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    testMock.mockResolvedValue({streamingMode: undefined, results: []});
    stderr = '';
    previousExitCode = process.exitCode;
    program = createProgram();
    applyTestOutput(program);
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
  });

  describe('record', () => {
    it('defaults the test paths to the tests directory', async () => {
      await parse(['conformance', 'record', 'sse']);

      expect(recordMock).toHaveBeenCalledWith({
        testPaths: [absolute('tests')],
        streamingMode: StreamingMode.SSE,
        agentsDir: process.cwd(),
      });
    });

    it.each([
      ['sse', StreamingMode.SSE],
      ['BIDI', StreamingMode.BIDI],
      ['None', StreamingMode.NONE],
    ])('converts the %s positional to its enum', async (value, expected) => {
      await parse(['conformance', 'record', value]);

      expect(recordMock.mock.calls[0][0].streamingMode).toBe(expected);
    });

    it('forwards the given directories, resolved, in order', async () => {
      await parse([
        'conformance',
        'record',
        EXISTING_DIR,
        OTHER_EXISTING_DIR,
        'none',
      ]);

      expect(recordMock.mock.calls[0][0].testPaths).toEqual([
        absolute(EXISTING_DIR),
        absolute(OTHER_EXISTING_DIR),
      ]);
    });

    it('exits 2 when the streaming mode is missing', async () => {
      const error = await parse(['conformance', 'record']);

      expect(error?.exitCode).toBe(2);
      expect(stderr).toContain('streaming_mode');
      expect(recordMock).not.toHaveBeenCalled();
    });

    it('exits 2 on an unknown streaming mode', async () => {
      const error = await parse(['conformance', 'record', 'eventstream']);

      expect(error?.exitCode).toBe(2);
      expect(stderr).toContain('eventstream');
      expect(recordMock).not.toHaveBeenCalled();
    });

    it('reports a recording failure with a non-zero exit code', async () => {
      recordMock.mockRejectedValue(new Error('disk is full'));

      await parse(['conformance', 'record', 'none']);

      expect(process.exitCode).toBe(1);
    });
  });

  describe('test', () => {
    it('uses the documented defaults', async () => {
      await parse(['conformance', 'test']);

      expect(testMock).toHaveBeenCalledWith({
        testPaths: [absolute('tests')],
        agentsDir: process.cwd(),
        mode: 'replay',
        generateReport: false,
        reportDir: undefined,
        streamingMode: undefined,
        force: false,
      });
    });

    it('forwards the mode and the report options', async () => {
      await parse([
        'conformance',
        'test',
        EXISTING_DIR,
        '--mode',
        'REPLAY',
        '--generate_report',
        '--report_dir',
        'reports',
        '--streaming-mode',
        'sse',
        '--force',
      ]);

      expect(testMock).toHaveBeenCalledWith({
        testPaths: [absolute(EXISTING_DIR)],
        agentsDir: process.cwd(),
        mode: 'replay',
        generateReport: true,
        reportDir: absolute('reports'),
        streamingMode: StreamingMode.SSE,
        force: true,
      });
    });

    it('accepts multiple directories', async () => {
      await parse(['conformance', 'test', EXISTING_DIR, OTHER_EXISTING_DIR]);

      expect(testMock.mock.calls[0][0].testPaths).toEqual([
        absolute(EXISTING_DIR),
        absolute(OTHER_EXISTING_DIR),
      ]);
    });

    it('forwards live mode', async () => {
      await parse(['conformance', 'test', '--mode', 'live']);

      expect(testMock.mock.calls[0][0].mode).toBe('live');
    });

    it('forwards the bidi streaming mode', async () => {
      await parse(['conformance', 'test', '--streaming-mode', 'bidi']);

      expect(testMock.mock.calls[0][0].streamingMode).toBe(StreamingMode.BIDI);
    });

    it('exits 2 on an unknown mode', async () => {
      const error = await parse(['conformance', 'test', '--mode', 'fast']);

      expect(error?.exitCode).toBe(2);
      expect(stderr).toContain('--mode');
      expect(testMock).not.toHaveBeenCalled();
    });

    it('exits 2 on an unknown streaming mode', async () => {
      const error = await parse([
        'conformance',
        'test',
        '--streaming-mode',
        'eventstream',
      ]);

      expect(error?.exitCode).toBe(2);
      expect(stderr).toContain('--streaming-mode');
      expect(testMock).not.toHaveBeenCalled();
    });

    it('exits 2 when a given path is not a directory', async () => {
      const error = await parse([
        'conformance',
        'test',
        'dev/test/cli/cli_conformance_test.ts',
      ]);

      expect(error?.exitCode).toBe(2);
      expect(stderr).toContain('dev/test/cli/cli_conformance_test.ts');
      expect(testMock).not.toHaveBeenCalled();
    });

    it('exits non-zero when a test case failed', async () => {
      testMock.mockResolvedValue({
        streamingMode: undefined,
        results: [
          {
            category: 'core',
            name: 'core/case_001',
            description: 'a case',
            status: ConformanceStatus.FAILED,
            error: 'events differ',
          },
        ],
      });

      await parse(['conformance', 'test']);

      expect(process.exitCode).toBe(1);
    });

    it('leaves the exit code alone when every case passed or was skipped', async () => {
      process.exitCode = 0;
      testMock.mockResolvedValue({
        streamingMode: StreamingMode.NONE,
        results: [
          {
            category: 'core',
            name: 'core/case_001',
            description: 'a case',
            status: ConformanceStatus.PASSED,
          },
          {
            category: 'core',
            name: 'core/case_002',
            description: 'another case',
            status: ConformanceStatus.SKIPPED,
          },
        ],
      });

      await parse(['conformance', 'test']);

      expect(process.exitCode).toBe(0);
    });

    it('reports a run that could not start with a non-zero exit code', async () => {
      testMock.mockRejectedValue(
        new Error('Live mode is not implemented yet.'),
      );

      await parse(['conformance', 'test', '--mode', 'live']);

      expect(process.exitCode).toBe(1);
    });
  });

  it('leaves the integration conformance command unchanged', async () => {
    await parse([
      'integration',
      'conformance',
      '--agents_dir',
      'agents',
      '--tests_dir',
      'cases',
      '--force',
    ]);

    expect(runIntegrationTests).toHaveBeenCalledWith({
      agentsDir: 'agents',
      testsDir: 'cases',
      forceRunAll: true,
    });
  });
});
