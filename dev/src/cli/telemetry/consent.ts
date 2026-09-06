/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CONFIG_FILE} from './constants.js';
import {readJsonObject} from './safe_fs.js';

/**
 * Reads the telemetry consent the user recorded in `~/.adk/config.json`.
 *
 * Returns `true` when the user opted in, `false` when the user opted out, and
 * `undefined` when no explicit preference exists or the file cannot be read.
 * Only `true` permits recording.
 */
export function readTelemetryConsent(
  configFile: string = CONFIG_FILE,
): boolean | undefined {
  const value = readJsonObject(configFile)?.['telemetry'];
  return typeof value === 'boolean' ? value : undefined;
}
