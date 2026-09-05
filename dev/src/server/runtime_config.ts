/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {errorMessage} from '../utils/error_utils.js';
import {isRecord} from '../utils/value_utils.js';

/** Path of the runtime config, relative to the served web assets directory. */
const RUNTIME_CONFIG_PATH = ['assets', 'config', 'runtime-config.json'];

/** Reported when only one of the two logo options is set. */
export const INCOMPLETE_LOGO_CONFIG_MESSAGE =
  'Both --logo-text and --logo-image-url must be defined when using logo ' +
  'config.';

/** The logo the dev UI draws in place of the ADK one. */
export interface UiLogoConfig {
  text: string;
  imageUrl: string;
}

/**
 * Reads the two logo options as one setting.
 *
 * @returns The logo, or `undefined` when neither option is set.
 * @throws {Error} When exactly one of the two is set, because the dev UI
 *   needs both to draw a logo.
 */
export function resolveLogoConfig(
  logoText?: string,
  logoImageUrl?: string,
): UiLogoConfig | undefined {
  if (!logoText && !logoImageUrl) {
    return undefined;
  }
  if (!logoText || !logoImageUrl) {
    throw new Error(INCOMPLETE_LOGO_CONFIG_MESSAGE);
  }
  return {text: logoText, imageUrl: logoImageUrl};
}

/** What the server injects into the dev UI's runtime config. */
export interface RuntimeConfigOptions {
  /** Directory the dev UI bundle is served from. */
  webAssetsDir: string;
  /** Path the dev UI reaches this server under, empty when there is none. */
  backendUrl: string;
  /** Recorded telemetry consent, absent when the user recorded none. */
  telemetry?: boolean;
  /** The logo to draw, absent when the operator configured none. */
  logo?: UiLogoConfig;
  logger: Logger;
}

/**
 * Writes the dev UI's `runtime-config.json`, so the UI reads the backend path,
 * the telemetry consent and the logo on load instead of asking for them.
 *
 * Keys the file already holds are preserved, because the shipped bundle
 * carries settings this server does not own. A write failure is reported and
 * swallowed: the UI falls back to its built-in defaults, which is a better
 * outcome than refusing to serve.
 */
export function writeRuntimeConfig(options: RuntimeConfigOptions): void {
  // Nothing serves the config when the bundle is absent, and writing it would
  // leave a directory tree standing in for a dev UI that was never built.
  if (!fs.existsSync(options.webAssetsDir)) {
    options.logger.info(
      `Web assets directory ${options.webAssetsDir} does not exist. The dev ` +
        `UI runtime config was not written.`,
    );
    return;
  }

  const configPath = path.join(options.webAssetsDir, ...RUNTIME_CONFIG_PATH);
  const runtimeConfig = readRuntimeConfig(configPath, options.logger);

  runtimeConfig['backendUrl'] = options.backendUrl;
  // Injected on bootstrap so the UI does not spend a request asking for it.
  runtimeConfig['telemetry'] = options.telemetry;
  if (options.logo) {
    runtimeConfig['logo'] = options.logo;
  } else {
    delete runtimeConfig['logo'];
  }

  try {
    fs.mkdirSync(path.dirname(configPath), {recursive: true});
    fs.writeFileSync(configPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`);
  } catch (error: unknown) {
    options.logger.error(
      `Failed to write runtime config file ${configPath}: ${errorMessage(error)}`,
    );
  }
}

/**
 * Reads the config the served bundle ships with. A missing file is the
 * ordinary first-run case; a file that does not parse is reported and then
 * overwritten, matching adk-python.
 */
function readRuntimeConfig(
  configPath: string,
  logger: Logger,
): Record<string, unknown> {
  if (!fs.existsSync(configPath)) {
    logger.info(
      `File not found: ${configPath}. A new runtime config file will be ` +
        `created.`,
    );
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error: unknown) {
    logger.warn(
      `Failed to read ${configPath}: ${errorMessage(error)}. The file ` +
        `content will be overwritten.`,
    );
    return {};
  }

  if (isRecord(parsed)) {
    return parsed;
  }
  logger.warn(
    `${configPath} does not hold a JSON object. The file content will be ` +
      `overwritten.`,
  );
  return {};
}
