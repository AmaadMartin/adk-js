/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {readJsonObject} from './fs_utils.js';
import {AdkLogger} from './logger.js';
import {toMessage} from './value_utils.js';

const logger = new AdkLogger({label: 'ADK CLI', colorize: {all: true}});

const TELEMETRY_KEY = 'telemetry';

/**
 * Returns the path of the ADK global config file.
 *
 * The location and the file name match adk-python, so the two SDKs share one
 * consent record on a machine that has both installed.
 */
export function getUserConfigPath(): string {
  return path.join(os.homedir(), '.adk', 'config.json');
}

/**
 * Reads the recorded telemetry consent.
 *
 * @returns `true` when the user opted in, `false` when the user opted out, and
 *   `undefined` when no preference is recorded or the config cannot be read.
 */
export function readTelemetryConsent(): boolean | undefined {
  const value = readJsonObject(getUserConfigPath())?.[TELEMETRY_KEY];
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Records the telemetry consent, preserving every other key in the config.
 *
 * @throws when the config file cannot be written.
 */
export function writeTelemetryConsent(enabled: boolean): void {
  const configPath = getUserConfigPath();
  try {
    fs.mkdirSync(path.dirname(configPath), {recursive: true});
    const config = readJsonObject(configPath) ?? {};
    config[TELEMETRY_KEY] = enabled;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf-8',
    });
  } catch (error: unknown) {
    logger.error(
      `Failed to write telemetry config to ${configPath}: ${toMessage(error)}`,
    );
    throw error;
  }
}
