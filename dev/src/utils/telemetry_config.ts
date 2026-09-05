/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {isRecord} from './file_utils.js';

/** Key the consent flag is recorded under in the ADK global config file. */
const TELEMETRY_KEY = 'telemetry';

/**
 * Returns the path of the ADK global config file.
 *
 * The directory and the file name match adk-python's
 * `google.adk.utils._telemetry_config.get_user_config_path`, so both SDKs read
 * one consent record on a machine that has them both installed.
 */
export function getUserConfigPath(): string {
  return path.join(os.homedir(), '.adk', 'config.json');
}

/**
 * Reads the recorded telemetry consent.
 *
 * @param logger Logger used to report a config file that cannot be read.
 * @returns `true` when the user opted in, `false` when the user opted out, and
 *   `undefined` when no preference is recorded or the config cannot be read.
 */
export function readTelemetryConsent(logger: Logger): boolean | undefined {
  const configPath = getUserConfigPath();
  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  try {
    const config: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const consent = isRecord(config) ? config[TELEMETRY_KEY] : undefined;

    return typeof consent === 'boolean' ? consent : undefined;
  } catch (e: unknown) {
    logger.warn(`Failed to read telemetry config from ${configPath}: ${e}`);

    return undefined;
  }
}
