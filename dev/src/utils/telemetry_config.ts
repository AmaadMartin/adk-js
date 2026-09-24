/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Returns the path of the ADK global config file, the same
 * `~/.adk/config.json` adk-python reads.
 */
export function getUserConfigPath(): string {
  return path.join(os.homedir(), '.adk', 'config.json');
}

/**
 * Reads the recorded telemetry consent from the ADK global config file.
 *
 * @returns `true` when the user opted in, `false` when the user opted out, and
 *     `null` when no preference is recorded or the file cannot be read.
 */
export async function readTelemetryConsent(
  logger: Logger,
): Promise<boolean | null> {
  const configPath = getUserConfigPath();
  try {
    const config: unknown = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    if (
      typeof config === 'object' &&
      config !== null &&
      'telemetry' in config
    ) {
      const consent: unknown = config.telemetry;
      return typeof consent === 'boolean' ? consent : null;
    }
    return null;
  } catch (e: unknown) {
    if (!isFileNotFound(e)) {
      logger.warn(`Failed to read telemetry config from ${configPath}: ${e}`);
    }
    return null;
  }
}

/**
 * An absent config file is the ordinary case for a user who never answered the
 * consent prompt, so it is reported as "no preference" without a warning.
 */
function isFileNotFound(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e.code === 'ENOENT' || e.code === 'ENOTDIR')
  );
}
