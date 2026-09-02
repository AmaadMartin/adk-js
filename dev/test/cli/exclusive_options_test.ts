/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Command, CommanderError} from 'commander';
import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {createProgram} from '../../src/cli/cli.js';
import {runAgent} from '../../src/cli/cli_run.js';
import {
  applyExclusiveOptions,
  USAGE_ERROR_EXIT_CODE,
} from '../../src/cli/exclusive_options.js';

vi.mock('../../src/cli/cli_run', () => ({
  runAgent: vi.fn(),
}));

/** Runs `command`, returning the error it raised, or undefined if it ran. */
async function runExpectingError(
  command: Command,
  argv: string[],
): Promise<CommanderError | undefined> {
  try {
    await command.parseAsync(argv, {from: 'user'});
    return undefined;
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      return error;
    }
    throw error;
  }
}

describe('applyExclusiveOptions', () => {
  const buildCommand = (ran: {options?: Record<string, string>}) => {
    const command = applyExclusiveOptions(new Command('seed'), [
      'replay',
      'resume',
      'restore',
    ])
      .option('--replay <string>', 'Replay a run.')
      .option('--resume <string>', 'Resume a session.')
      .option('--restore <string>', 'Restore a snapshot.')
      .action((options: Record<string, string>) => {
        ran.options = options;
      });
    command.exitOverride();
    return command;
  };

  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  it('runs the command when no exclusive option is set', async () => {
    const ran: {options?: Record<string, string>} = {};

    expect(await runExpectingError(buildCommand(ran), [])).toBeUndefined();
    expect(ran.options).toEqual({});
  });

  it('runs the command when exactly one exclusive option is set', async () => {
    const ran: {options?: Record<string, string>} = {};

    const error = await runExpectingError(buildCommand(ran), [
      '--resume',
      'session.json',
    ]);

    expect(error).toBeUndefined();
    expect(ran.options).toEqual({resume: 'session.json'});
  });

  it('refuses two exclusive options, and never runs the command', async () => {
    const ran: {options?: Record<string, string>} = {};

    const error = await runExpectingError(buildCommand(ran), [
      '--replay',
      'a.json',
      '--resume',
      'b.json',
    ]);

    expect(error?.code).toBe('adk.exclusiveOptions');
    expect(error?.exitCode).toBe(USAGE_ERROR_EXIT_CODE);
    expect(error?.message).toBe(
      "error: Options 'resume' and 'replay' cannot be set together.",
    );
    expect(ran.options).toBeUndefined();
  });

  it('names the conflicting option first and the one already seen second', async () => {
    const ran: {options?: Record<string, string>} = {};

    const error = await runExpectingError(buildCommand(ran), [
      '--restore',
      'c.json',
      '--replay',
      'a.json',
    ]);

    // The order follows the declared option order, not the command line, so
    // the message reads the same whichever way round the flags are typed.
    expect(error?.message).toBe(
      "error: Options 'restore' and 'replay' cannot be set together.",
    );
  });
});

describe('adk run', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    program = createProgram();
    program.exitOverride();
    for (const command of program.commands) {
      command.exitOverride();
    }
  });

  it('refuses --replay together with --resume, and never starts an agent', async () => {
    const error = await runExpectingError(program, [
      'run',
      'agent.ts',
      '--replay',
      'replay.json',
      '--resume',
      'resume.json',
    ]);

    expect(error?.exitCode).toBe(USAGE_ERROR_EXIT_CODE);
    expect(error?.message).toBe(
      "error: Options 'resume' and 'replay' cannot be set together.",
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('passes --replay on its own through to the agent run', async () => {
    const error = await runExpectingError(program, [
      'run',
      'agent.ts',
      '--replay',
      'replay.json',
    ]);

    expect(error).toBeUndefined();
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPath: 'agent.ts',
        inputFile: 'replay.json',
        savedSessionFile: undefined,
      }),
    );
  });

  it('passes --resume on its own through to the agent run', async () => {
    const error = await runExpectingError(program, [
      'run',
      'agent.ts',
      '--resume',
      'resume.json',
    ]);

    expect(error).toBeUndefined();
    expect(runAgent as Mock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPath: 'agent.ts',
        inputFile: undefined,
        savedSessionFile: 'resume.json',
      }),
    );
  });
});
