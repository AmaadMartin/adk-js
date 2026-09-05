/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {isRecord} from '../utils/file_utils.js';
import {readTelemetryConsent} from '../utils/telemetry_config.js';

/** Location of the config file, relative to the dev UI's asset directory. */
const RUNTIME_CONFIG_RELATIVE_PATH = [
  'assets',
  'config',
  'runtime-config.json',
];

/** Rejection message when only one half of the logo pair is configured. */
export const LOGO_CONFIG_ERROR_MESSAGE =
  'Both --logo-text and --logo-image-url must be defined when using logo config.';

/** Branding and routing the dev UI reads at boot. */
export interface RuntimeConfigOptions {
  /** Path prefix the dev UI calls the backend under. Defaults to `''`. */
  urlPrefix?: string;
  /** Text shown in the dev UI logo. Requires `logoImageUrl`. */
  logoText?: string;
  /** Image shown in the dev UI logo. Requires `logoText`. */
  logoImageUrl?: string;
}

/**
 * Reads the config the dev UI build shipped, so keys this server does not own
 * survive the rewrite. A file that is absent or unparseable yields an empty
 * config, which the write below then replaces.
 */
function readRuntimeConfig(
  configPath: string,
  logger: Logger,
): Record<string, unknown> {
  if (!fs.existsSync(configPath)) {
    logger.info(
      `File not found: ${configPath}. A new runtime config file will be created.`,
    );

    return {};
  }

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

    return isRecord(parsed) ? parsed : {};
  } catch (e: unknown) {
    logger.warn(
      `Failed to decode JSON from ${configPath}. The file content will be overwritten: ${e}`,
    );

    return {};
  }
}

/**
 * Writes `assets/config/runtime-config.json` next to the dev UI assets, so the
 * UI boots with the backend URL, the telemetry consent and the logo already in
 * hand instead of asking for them.
 *
 * A write failure is logged and swallowed: branding is not worth refusing to
 * serve over. A half-configured logo is not, and rejects.
 *
 * @throws when exactly one of `logoText` and `logoImageUrl` is set.
 */
export function setupRuntimeConfig(
  webAssetsDir: string,
  options: RuntimeConfigOptions,
  logger: Logger,
): void {
  const configPath = path.join(webAssetsDir, ...RUNTIME_CONFIG_RELATIVE_PATH);
  const config = readRuntimeConfig(configPath, logger);

  config['backendUrl'] = options.urlPrefix ?? '';
  config['telemetry'] = readTelemetryConsent(logger) ?? null;

  if (options.logoText || options.logoImageUrl) {
    if (!options.logoText || !options.logoImageUrl) {
      throw new Error(LOGO_CONFIG_ERROR_MESSAGE);
    }
    config['logo'] = {text: options.logoText, imageUrl: options.logoImageUrl};
  } else {
    delete config['logo'];
  }

  try {
    fs.mkdirSync(path.dirname(configPath), {recursive: true});
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf-8',
    });
  } catch (e: unknown) {
    logger.error(`Failed to write runtime config file ${configPath}: ${e}`);
  }
}
