/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Command} from 'commander';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  maybePromptForTelemetryConsent,
  registerTelemetryCommands,
} from '../../src/cli/cli_telemetry.js';
import {
  readTelemetryConsent,
  writeTelemetryConsent,
} from '../../src/utils/telemetry_config.js';

vi.mock('../../src/utils/telemetry_config.js', () => ({
  readTelemetryConsent: vi.fn(),
  writeTelemetryConsent: vi.fn(),
}));

const {readlineState} = vi.hoisted(() => ({
  readlineState: {
    answer: '',
    emit: undefined as string | undefined,
    prompts: [] as string[],
    closed: false,
  },
}));

vi.mock('node:readline', () => ({
  createInterface: () => {
    const listeners = new Map<string, () => void>();
    return {
      once: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
      question: (prompt: string, callback: (answer: string) => void) => {
        readlineState.prompts.push(prompt);
        if (readlineState.emit) {
          listeners.get(readlineState.emit)?.();
          return;
        }
        callback(readlineState.answer);
      },
      close: () => {
        readlineState.closed = true;
      },
    };
  },
}));

const mockedRead = vi.mocked(readTelemetryConsent);
const mockedWrite = vi.mocked(writeTelemetryConsent);

describe('cli_telemetry', () => {
  let stdout: string[];
  let stderr: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = [];
    stderr = [];
    readlineState.answer = '';
    readlineState.emit = undefined;
    readlineState.prompts = [];
    readlineState.closed = false;
    logSpy = vi
      .spyOn(console, 'log')
      .mockImplementation((...args: unknown[]) => {
        stdout.push(args.join(' '));
      });
    errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        stderr.push(args.join(' '));
      });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    vi.restoreAllMocks();
  });

  const buildProgram = (): Command => {
    const program = new Command('adk');
    program.exitOverride();
    program.configureOutput({
      writeOut: (str) => stdout.push(str),
      writeErr: (str) => stderr.push(str),
    });
    registerTelemetryCommands(program);
    return program;
  };

  const run = async (args: string[]): Promise<number> => {
    try {
      await buildProgram().parseAsync(['node', 'adk', ...args]);
      return 0;
    } catch (error: unknown) {
      if (error instanceof Error && 'exitCode' in error) {
        return Number(error.exitCode);
      }
      throw error;
    }
  };

  describe('telemetry group', () => {
    it('prints its usage when invoked without a subcommand', async () => {
      await run(['telemetry']);

      const output = [...stdout, ...stderr].join('\n');
      expect(output).toContain('enable');
      expect(output).toContain('disable');
      expect(output).toContain('status');
    });

    it.each([
      [true, 'Telemetry collection is enabled.'],
      [false, 'Telemetry collection is disabled.'],
      [undefined, 'Telemetry collection is not configured (defaults to OFF).'],
    ])('status reports consent %s', async (consent, message) => {
      mockedRead.mockReturnValue(consent);

      await run(['telemetry', 'status']);

      expect(stdout).toContain(message);
    });

    it.each([
      ['enable', true, 'Telemetry collection has been enabled.'],
      ['disable', false, 'Telemetry collection has been disabled.'],
    ])('%s records the consent', async (subcommand, expected, message) => {
      await run(['telemetry', subcommand]);

      expect(mockedWrite).toHaveBeenCalledWith(expected);
      expect(stdout).toContain(message);
    });

    it.each([
      ['enable', 'Error: Failed to enable telemetry: disk on fire'],
      ['disable', 'Error: Failed to disable telemetry: disk on fire'],
    ])('%s exits 1 when the write fails', async (subcommand, message) => {
      mockedWrite.mockImplementation(() => {
        throw new Error('disk on fire');
      });

      const exitCode = await run(['telemetry', subcommand]);

      expect(exitCode).toBe(1);
      expect(stderr.join('')).toContain(message);
      expect(stdout.join('')).not.toContain('has been');
    });
  });

  describe('maybePromptForTelemetryConsent', () => {
    let originalIsTty: boolean | undefined;

    beforeEach(() => {
      originalIsTty = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      mockedRead.mockReturnValue(undefined);
    });

    afterEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTty,
        configurable: true,
      });
    });

    it.each([
      ['an empty answer', ''],
      ['y', 'y'],
      ['YES with padding', '  YES  '],
    ])('opts in on %s', async (_name, answer) => {
      readlineState.answer = answer;

      await maybePromptForTelemetryConsent('web', ['adk', 'web']);

      expect(mockedWrite).toHaveBeenCalledWith(true);
      expect(readlineState.prompts).toEqual(['Enable telemetry? [Y/n]: ']);
    });

    it('shows the question, the details and the opt-out note', async () => {
      await maybePromptForTelemetryConsent('web', ['adk', 'web']);

      const output = stdout.join('\n');
      expect(output).toContain('Help improve the ADK (CLI and Web UI)');
      expect(output).toContain('What is collected:');
      expect(output).toContain('This is OFF by default.');
    });

    it.each([['n'], ['no'], ['maybe']])('opts out on %s', async (answer) => {
      readlineState.answer = answer;

      await maybePromptForTelemetryConsent('web', ['adk', 'web']);

      expect(mockedWrite).toHaveBeenCalledWith(false);
    });

    it.each([['close'], ['SIGINT']])(
      'leaves the consent unset on %s',
      async (event) => {
        readlineState.emit = event;

        await maybePromptForTelemetryConsent('web', ['adk', 'web']);

        expect(mockedWrite).not.toHaveBeenCalled();
      },
    );

    it('reports a write failure without throwing', async () => {
      mockedWrite.mockImplementation(() => {
        throw new Error('read-only home');
      });

      await maybePromptForTelemetryConsent('web', ['adk', 'web']);

      expect(stderr.join('')).toContain(
        'Error: Failed to save telemetry settings: read-only home',
      );
    });

    it('closes the readline interface', async () => {
      await maybePromptForTelemetryConsent('web', ['adk', 'web']);

      expect(readlineState.closed).toBe(true);
    });

    it.each([
      ['the subcommand manages telemetry', 'telemetry', ['adk', 'telemetry']],
      ['--help was requested', 'web', ['adk', 'web', '--help']],
    ])('does not prompt when %s', async (_name, subcommand, argv) => {
      await maybePromptForTelemetryConsent(subcommand, argv);

      expect(readlineState.prompts).toEqual([]);
      expect(mockedWrite).not.toHaveBeenCalled();
    });

    it('does not prompt when stdin is not a terminal', async () => {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true,
      });

      await maybePromptForTelemetryConsent('web', ['adk', 'web']);

      expect(readlineState.prompts).toEqual([]);
      expect(mockedWrite).not.toHaveBeenCalled();
    });

    it.each([[true], [false]])(
      'does not prompt when the consent is already %s',
      async (consent) => {
        mockedRead.mockReturnValue(consent);

        await maybePromptForTelemetryConsent('web', ['adk', 'web']);

        expect(readlineState.prompts).toEqual([]);
        expect(mockedWrite).not.toHaveBeenCalled();
      },
    );
  });
});
