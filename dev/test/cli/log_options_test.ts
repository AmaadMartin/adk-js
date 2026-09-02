/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel} from '@google/adk';
import {Command, CommanderError} from 'commander';
import {describe, expect, it, vi} from 'vitest';
import {
  applyVerboseLogLevel,
  getLogLevelFromOptions,
  LOG_LEVEL_CHOICES,
  LOG_LEVEL_OPTION,
  VERBOSE_OPTION,
} from '../../src/cli/log_options.js';

describe('getLogLevelFromOptions', () => {
  it.each([
    ['DEBUG', LogLevel.DEBUG],
    ['INFO', LogLevel.INFO],
    ['WARNING', LogLevel.WARN],
    ['WARN', LogLevel.WARN],
    ['ERROR', LogLevel.ERROR],
    ['CRITICAL', LogLevel.ERROR],
  ])('maps %s to the matching LogLevel', (name, expected) => {
    expect(getLogLevelFromOptions({log_level: name})).toBe(expected);
    expect(getLogLevelFromOptions({log_level: name.toLowerCase()})).toBe(
      expected,
    );
  });

  it('falls back to INFO when the flag is absent', () => {
    expect(getLogLevelFromOptions({})).toBe(LogLevel.INFO);
  });

  it('falls back to INFO for a name the CLI never produces', () => {
    // The option parser rejects an unknown name, so this only guards a caller
    // that builds the options object itself.
    expect(getLogLevelFromOptions({log_level: 'TRACE'})).toBe(LogLevel.INFO);
  });
});

describe('applyVerboseLogLevel', () => {
  const buildProgram = (resolved: {level?: LogLevel}) => {
    const program = applyVerboseLogLevel(new Command('adk'));
    program
      .command('serve')
      .addOption(VERBOSE_OPTION)
      .addOption(LOG_LEVEL_OPTION)
      .action((options: {verbose?: boolean; log_level?: string}) => {
        resolved.level = getLogLevelFromOptions(options);
      });
    program
      .command('bare')
      .action(() => {
        resolved.level = LogLevel.ERROR;
      })
      .exitOverride();
    program.exitOverride();
    for (const command of program.commands) {
      command.exitOverride();
    }
    return program;
  };

  it('raises a defaulted --log_level to DEBUG for --verbose', async () => {
    const resolved: {level?: LogLevel} = {};

    await buildProgram(resolved).parseAsync(['serve', '--verbose'], {
      from: 'user',
    });

    expect(resolved.level).toBe(LogLevel.DEBUG);
  });

  it('leaves an explicit --log_level alone when --verbose is also given', async () => {
    const resolved: {level?: LogLevel} = {};

    await buildProgram(resolved).parseAsync(
      ['serve', '--verbose', '--log_level', 'ERROR'],
      {from: 'user'},
    );

    expect(resolved.level).toBe(LogLevel.ERROR);
  });

  it('honours --log_level debug, which the old `||` fallback discarded', async () => {
    const resolved: {level?: LogLevel} = {};

    await buildProgram(resolved).parseAsync(['serve', '--log_level', 'debug'], {
      from: 'user',
    });

    expect(resolved.level).toBe(LogLevel.DEBUG);
  });

  it('leaves a command without the logging flags untouched', async () => {
    const resolved: {level?: LogLevel} = {};

    await buildProgram(resolved).parseAsync(['bare'], {from: 'user'});

    expect(resolved.level).toBe(LogLevel.ERROR);
  });

  it('refuses a --log_level outside the choice list', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const resolved: {level?: LogLevel} = {};

    const error = await buildProgram(resolved)
      .parseAsync(['serve', '--log_level', 'verbose'], {from: 'user'})
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CommanderError);
    expect((error as CommanderError).code).toBe('commander.invalidArgument');
    expect(resolved.level).toBeUndefined();
  });
});

describe('LOG_LEVEL_CHOICES', () => {
  it('carries the names adk-python declares, plus the legacy WARN', () => {
    expect([...LOG_LEVEL_CHOICES]).toEqual([
      'DEBUG',
      'INFO',
      'WARNING',
      'WARN',
      'ERROR',
      'CRITICAL',
    ]);
  });
});
