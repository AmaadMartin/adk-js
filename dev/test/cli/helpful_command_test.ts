/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Command} from 'commander';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {applyHelpfulCommand} from '../../src/cli/helpful_command.js';

/** Thrown by the mocked `process.exit`, so a test stops where the CLI would. */
class ProcessExited extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let stdout: string[];
let stderr: string[];
let exitCodes: number[];
let action: ReturnType<typeof vi.fn>;

/** A command shaped like the ones adk-python marks `HelpfulCommand`. */
function buildCommand(): Command {
  return applyHelpfulCommand(new Command('deploy'))
    .description('Deploys the agent somewhere')
    .argument('<target_path>', 'Where to deploy the agent')
    .requiredOption('--out_file <path>', 'Where to write the manifest')
    .option('--dry_run', 'Print what would happen and stop')
    .action(action);
}

async function parse(command: Command, args: string[]): Promise<void> {
  try {
    await command.parseAsync(args, {from: 'user'});
  } catch (err: unknown) {
    if (!(err instanceof ProcessExited)) {
      throw err;
    }
  }
}

beforeEach(() => {
  stdout = [];
  stderr = [];
  exitCodes = [];
  action = vi.fn();
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    exitCodes.push(Number(code));
    throw new ProcessExited(Number(code));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applyHelpfulCommand', () => {
  it('prints the whole help when a required argument is missing', async () => {
    await parse(buildCommand(), ['--out_file', 'out.json']);

    const help = stdout.join('');
    expect(help).toContain('Usage: deploy [options] <target_path>');
    expect(help).toContain('Deploys the agent somewhere');
    expect(help).toContain('Where to write the manifest');
    expect(help).toContain('Print what would happen and stop');
    expect(stderr.join('')).toBe(
      '\nError: Missing required argument: TARGET_PATH\n',
    );
    expect(exitCodes).toEqual([2]);
    expect(action).not.toHaveBeenCalled();
  });

  it('names a missing required option by its parameter name', async () => {
    await parse(buildCommand(), ['./agent.ts']);

    expect(stderr.join('')).toBe(
      '\nError: Missing required argument: OUT_FILE\n',
    );
    expect(stderr.join('')).not.toContain('required option');
    expect(exitCodes).toEqual([2]);
  });

  it('parses normally when every required parameter is supplied', async () => {
    await parse(buildCommand(), ['./agent.ts', '--out_file', 'out.json']);

    expect(action).toHaveBeenCalledOnce();
    expect(stdout.join('')).toBe('');
    expect(stderr.join('')).toBe('');
    expect(exitCodes).toEqual([]);
  });

  it('leaves a missing-parameter error that names nothing to commander', () => {
    const command = buildCommand();

    expect(() =>
      command.error('error: missing something', {
        code: 'commander.missingArgument',
      }),
    ).toThrow(ProcessExited);

    expect(stderr.join('')).toBe('error: missing something\n');
    expect(stdout.join('')).toBe('');
    expect(exitCodes).toEqual([1]);
  });

  it('leaves any other usage error to commander', async () => {
    await parse(buildCommand(), ['./agent.ts', '--out_file', 'o', '--nope']);

    expect(stderr.join('')).toContain("error: unknown option '--nope'");
    expect(stdout.join('')).toBe('');
    expect(exitCodes).toEqual([1]);
  });
});
