/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const DURATION_PATTERN = /^(\d+)([sm])?$/;
const MILLIS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/**
 * Parses a duration such as `30`, `30s` or `5m` into milliseconds.
 *
 * A bare number is read as seconds, matching the CLI durations adk-python
 * accepts.
 *
 * @param value The duration to parse.
 * @return The duration in milliseconds.
 * @throws Error when the value is not a whole number of seconds or minutes.
 */
export function parseDuration(value: string): number {
  const match = DURATION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid timeout format: ${value}`);
  }

  const amount = Number(match[1]);
  const seconds = match[2] === 'm' ? amount * SECONDS_PER_MINUTE : amount;
  return seconds * MILLIS_PER_SECOND;
}
