/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

/** Logo block published to the dev UI, matching adk-python's JSON shape. */
export interface LogoConfig {
  text: string;
  imageUrl: string;
}

/** Runtime configuration served to the dev UI. */
export type RuntimeConfig = Record<string, unknown>;

/** Location of the runtime config inside the bundled dev UI assets. */
export const RUNTIME_CONFIG_RELATIVE_PATH = path.join(
  'assets',
  'config',
  'runtime-config.json',
);

/** Key the dev UI reads the logo block from. */
const LOGO_KEY = 'logo';

/**
 * Validates a logo option pair and turns it into the block the dev UI reads.
 *
 * The checks are on truthiness rather than on `undefined`, so an empty string
 * counts as "not supplied" exactly as it does in adk-python.
 *
 * @param logoText Text to display next to the logo.
 * @param logoImageUrl URL of the logo image.
 * @returns The logo block, or `undefined` when neither value was supplied.
 * @throws Error if exactly one of the two values was supplied.
 */
export function resolveLogoConfig(
  logoText?: string,
  logoImageUrl?: string,
): LogoConfig | undefined {
  if (!logoText && !logoImageUrl) {
    return undefined;
  }

  if (!logoText || !logoImageUrl) {
    throw new Error(
      'Both logoText and logoImageUrl must be defined when using logo config.',
    );
  }

  return {text: logoText, imageUrl: logoImageUrl};
}

/**
 * Merges server-supplied values into the runtime config that ships with the
 * dev UI bundle, without mutating it.
 *
 * @param base Contents of the bundled `runtime-config.json`.
 * @param logo Logo block to publish, or `undefined` to publish none.
 * @returns A new config that keeps every key of `base`.
 */
export function buildRuntimeConfig(
  base: RuntimeConfig,
  logo: LogoConfig | undefined,
): RuntimeConfig {
  const config: RuntimeConfig = {...base};

  if (logo) {
    config[LOGO_KEY] = logo;
  } else {
    delete config[LOGO_KEY];
  }

  return config;
}
