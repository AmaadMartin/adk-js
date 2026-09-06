/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Command} from 'commander';
import * as readline from 'node:readline';
import {
  readTelemetryConsent,
  writeTelemetryConsent,
} from '../utils/telemetry_config.js';
import {toMessage} from '../utils/value_utils.js';

const CONSENT_QUESTION =
  'Help improve the ADK (CLI and Web UI) by allowing Google to collect' +
  ' pseudonymized usage data?';

const CONSENT_DETAILS =
  'What is collected: Names of subcommands and flags (no user-provided' +
  ' values or arguments), execution metrics (duration, exit state),' +
  ' environment specs (OS, Node.js version), and aggregated Web UI' +
  ' feature interactions. No personally identifiable information (PII)' +
  ' is collected.';

const CONSENT_OPT_OUT =
  'This is OFF by default. You can opt out at any time using the' +
  " 'adk telemetry disable' command or Web UI user settings.";

const CONSENT_PROMPT = 'Enable telemetry? [Y/n]: ';

const AFFIRMATIVE_ANSWERS = new Set(['', 'y', 'yes']);

/** Records the consent and echoes it, or fails the command with exit code 1. */
function recordConsent(command: Command, enabled: boolean): void {
  try {
    writeTelemetryConsent(enabled);
  } catch (error: unknown) {
    const verb = enabled ? 'enable' : 'disable';
    command.error(`Error: Failed to ${verb} telemetry: ${toMessage(error)}`);
  }
  console.log(
    `Telemetry collection has been ${enabled ? 'enabled' : 'disabled'}.`,
  );
}

/**
 * Adds the `telemetry` command group to the given program.
 *
 * The group only manages the recorded consent. adk-js has no metrics
 * collector, so nothing reads the consent yet.
 */
export function registerTelemetryCommands(program: Command): void {
  const telemetry = program
    .command('telemetry')
    .description('Manage telemetry settings');

  telemetry
    .command('enable')
    .description('Enable telemetry collection')
    .action((_options: Record<string, never>, command: Command) => {
      recordConsent(command, true);
    });

  telemetry
    .command('disable')
    .description('Disable telemetry collection')
    .action((_options: Record<string, never>, command: Command) => {
      recordConsent(command, false);
    });

  telemetry
    .command('status')
    .description('Show telemetry collection status')
    .action(() => {
      const consent = readTelemetryConsent();
      if (consent === true) {
        console.log('Telemetry collection is enabled.');
      } else if (consent === false) {
        console.log('Telemetry collection is disabled.');
      } else {
        console.log(
          'Telemetry collection is not configured (defaults to OFF).',
        );
      }
    });
}

/** Reads one line, resolving to undefined when stdin closes first. */
async function askConsent(): Promise<string | undefined> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise<string | undefined>((resolve) => {
      rl.once('close', () => resolve(undefined));
      rl.once('SIGINT', () => resolve(undefined));
      rl.question(CONSENT_PROMPT, resolve);
    });
  } finally {
    rl.close();
  }
}

/**
 * Asks for telemetry consent once, before the first subcommand that is not
 * `telemetry` itself runs.
 *
 * The prompt is skipped when a preference is already recorded, when the user
 * asked for help, and whenever stdin is not a terminal, so an automated run
 * can never block on it. Only `--help` counts as a help request: adk-js binds
 * `-h` to `--host` on its subcommands.
 *
 * A failure to record the answer is reported and then ignored, so consent
 * never blocks the command the user actually asked for.
 */
export async function maybePromptForTelemetryConsent(
  subcommandName: string,
  argv: string[],
): Promise<void> {
  if (
    subcommandName === 'telemetry' ||
    argv.includes('--help') ||
    !process.stdin.isTTY ||
    readTelemetryConsent() !== undefined
  ) {
    return;
  }

  console.log(CONSENT_QUESTION);
  console.log();
  console.log(CONSENT_DETAILS);
  console.log();
  console.log(CONSENT_OPT_OUT);
  console.log();

  const answer = await askConsent();
  if (answer === undefined) {
    console.log();
    return;
  }

  try {
    writeTelemetryConsent(AFFIRMATIVE_ANSWERS.has(answer.trim().toLowerCase()));
  } catch (error: unknown) {
    console.error(
      `Error: Failed to save telemetry settings: ${toMessage(error)}`,
    );
  }
}
