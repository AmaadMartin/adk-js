/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {readTelemetryConsent} from '../utils/telemetry_config.js';

/**
 * Rejection message for a half-configured logo, kept verbatim from
 * adk-python's `_setup_runtime_config`. It names the reference's hyphenated
 * flags; the adk-js flags are `--logo_text` and `--logo_image_url`.
 */
export const LOGO_CONFIG_ERROR_MESSAGE =
  'Both --logo-text and --logo-image-url must be defined when using logo config.';

/** The dev UI reads its runtime configuration from this path. */
const RUNTIME_CONFIG_RELATIVE_PATH = path.join(
  'assets',
  'config',
  'runtime-config.json',
);

/** The runtime-config values an operator can set on the server. */
export interface RuntimeConfigOptions {
  /** Path the server is reached under behind a reverse proxy, e.g. `/adk`. */
  urlPrefix?: string;
  /** Text shown in the dev UI's logo. Set it with {@link logoImageUrl}. */
  logoText?: string;
  /** Image shown in the dev UI's logo. Set it with {@link logoText}. */
  logoImageUrl?: string;
}

/**
 * Merges the server's configuration into the dev UI's
 * `assets/config/runtime-config.json`, creating the file when it is absent.
 *
 * Keys the file already holds and this function does not name are preserved.
 * A read-only asset directory must not stop the server from serving, so a
 * write failure is logged rather than thrown.
 *
 * @param webAssetsDir The directory the dev UI is served from.
 * @param options The runtime-config values to write.
 * @param logger The server logger.
 * @throws Error when exactly one of `logoText` and `logoImageUrl` is set.
 */
export async function writeRuntimeConfig(
  webAssetsDir: string,
  options: RuntimeConfigOptions,
  logger: Logger,
): Promise<void> {
  validateLogoOptions(options);
  const configPath = path.join(webAssetsDir, RUNTIME_CONFIG_RELATIVE_PATH);
  const config = await readRuntimeConfig(configPath, logger);

  config['backendUrl'] = options.urlPrefix ?? '';
  // Injected on start-up so the dev UI does not need an extra request to
  // learn the consent it was launched with.
  config['telemetry'] = await readTelemetryConsent(logger);
  applyLogo(config, options);

  try {
    await fs.mkdir(path.dirname(configPath), {recursive: true});
    await fs.writeFile(
      configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      'utf-8',
    );
  } catch (e: unknown) {
    logger.error(`Failed to write runtime config file ${configPath}: ${e}`);
  }
}

/**
 * Reads the runtime config already on disk. A missing file starts an empty
 * config; unreadable content is reported and overwritten.
 */
async function readRuntimeConfig(
  configPath: string,
  logger: Logger,
): Promise<Record<string, unknown>> {
  let contents: string;
  try {
    contents = await fs.readFile(configPath, 'utf-8');
  } catch {
    logger.info(
      `File not found: ${configPath}. A new runtime config file will be created.`,
    );
    return {};
  }

  const parsed = parseJson(contents);
  if (!isRecord(parsed)) {
    logger.warn(
      `Failed to decode JSON from ${configPath}. The file content will be overwritten.`,
    );
    return {};
  }
  return {...parsed};
}

/**
 * Rejects a half-configured logo. The dev UI needs both halves, so setting one
 * alone is a start-up error rather than a partly branded UI.
 *
 * @param options The runtime-config values to check.
 * @throws Error when exactly one of `logoText` and `logoImageUrl` is set.
 */
export function validateLogoOptions(options: RuntimeConfigOptions): void {
  if (Boolean(options.logoText) !== Boolean(options.logoImageUrl)) {
    throw new Error(LOGO_CONFIG_ERROR_MESSAGE);
  }
}

/** Writes or removes the `logo` block, matching the reference's semantics. */
function applyLogo(
  config: Record<string, unknown>,
  options: RuntimeConfigOptions,
): void {
  if (options.logoText && options.logoImageUrl) {
    config['logo'] = {text: options.logoText, imageUrl: options.logoImageUrl};
    return;
  }
  // Deleting is how an operator turns a previously configured logo off.
  delete config['logo'];
}

function parseJson(contents: string): unknown {
  try {
    return JSON.parse(contents);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
