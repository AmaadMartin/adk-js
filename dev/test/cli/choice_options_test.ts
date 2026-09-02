/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Command, CommanderError, InvalidArgumentError} from 'commander';
import {describe, expect, it, vi} from 'vitest';
import {
  createChoiceOption,
  normalizeChoice,
} from '../../src/cli/choice_options.js';

const FRUITS = ['APPLE', 'PEAR'] as const;

describe('normalizeChoice', () => {
  it('returns the declared spelling of a lower-case value', () => {
    expect(normalizeChoice('apple', FRUITS)).toBe('APPLE');
  });

  it('returns a value that already matches a choice', () => {
    expect(normalizeChoice('PEAR', FRUITS)).toBe('PEAR');
  });

  it('rejects a value that is not a choice, and lists the choices', () => {
    expect(() => normalizeChoice('plum', FRUITS)).toThrow(InvalidArgumentError);
    expect(() => normalizeChoice('plum', FRUITS)).toThrow(
      'Allowed choices are APPLE, PEAR.',
    );
  });
});

describe('createChoiceOption', () => {
  const buildCommand = (received: {value?: string}) => {
    const command = new Command('pick')
      .addOption(createChoiceOption('--fruit <string>', 'A fruit.', FRUITS))
      .action((options: {fruit?: string}) => {
        received.value = options.fruit;
      });
    command.exitOverride();
    return command;
  };

  it('normalizes the parsed value to the declared spelling', async () => {
    const received: {value?: string} = {};

    await buildCommand(received).parseAsync(['--fruit', 'apple'], {
      from: 'user',
    });

    expect(received.value).toBe('APPLE');
  });

  it('fails the command when the value is not a choice', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const received: {value?: string} = {};

    const error = await buildCommand(received)
      .parseAsync(['--fruit', 'plum'], {from: 'user'})
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CommanderError);
    expect((error as CommanderError).code).toBe('commander.invalidArgument');
    expect(received.value).toBeUndefined();
  });

  it('lists the choices in the help output', () => {
    const received: {value?: string} = {};

    expect(buildCommand(received).helpInformation()).toContain(
      'choices: "APPLE", "PEAR"',
    );
  });
});
