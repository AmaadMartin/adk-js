/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InvalidArgumentError, Option} from 'commander';

/**
 * Builds an option whose value must be one of `choices`, matched without
 * regard to case and normalized to the declared spelling.
 *
 * adk-python declares these with `click.Choice(..., case_sensitive=False)`.
 * Commander's own `.choices()` is case-sensitive, so the check lives in the
 * argument parser instead. `argChoices` still lists the values in `--help`.
 */
export function createChoiceOption(
  flags: string,
  description: string,
  choices: readonly string[],
): Option {
  const option = new Option(flags, description).argParser((value: string) =>
    normalizeChoice(value, choices),
  );
  option.argChoices = [...choices];
  return option;
}

/**
 * Returns the declared spelling of `value`.
 *
 * @throws InvalidArgumentError when `value` is not one of `choices`. Commander
 *   turns that into its usual `error: option ... is invalid` message.
 */
export function normalizeChoice(
  value: string,
  choices: readonly string[],
): string {
  const normalized = choices.find(
    (choice) => choice.toLowerCase() === value.toLowerCase(),
  );
  if (normalized === undefined) {
    throw new InvalidArgumentError(
      `Allowed choices are ${choices.join(', ')}.`,
    );
  }
  return normalized;
}
