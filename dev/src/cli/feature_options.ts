/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FeatureName, overrideFeatureEnabled} from '@google/adk';
import {Command, Option} from 'commander';

const ENABLE_FEATURES_KEY = 'enable_features';
const DISABLE_FEATURES_KEY = 'disable_features';

/** Collects a repeatable option into a list, matching click's `multiple=True`. */
function appendValue(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export const ENABLE_FEATURES_OPTION = new Option(
  `--${ENABLE_FEATURES_KEY} <string>`,
  'Optional. Comma-separated list of feature names to enable. This provides ' +
    'an alternative to environment variables for enabling experimental ' +
    `features. Example: --${ENABLE_FEATURES_KEY}=${FeatureName.PROGRESSIVE_SSE_STREAMING}`,
).argParser(appendValue);

export const DISABLE_FEATURES_OPTION = new Option(
  `--${DISABLE_FEATURES_KEY} <string>`,
  'Optional. Comma-separated list of feature names to disable. This provides ' +
    'an alternative to environment variables for disabling ' +
    `features. Example: --${DISABLE_FEATURES_KEY}=${FeatureName.PROGRESSIVE_SSE_STREAMING}`,
).argParser(appendValue);

/** What `appendValue` collects into, keyed by the flag names above. */
interface FeatureOptionValues {
  [ENABLE_FEATURES_KEY]?: string[];
  [DISABLE_FEATURES_KEY]?: string[];
}

function toFeatureName(value: string): FeatureName | undefined {
  return Object.values(FeatureName).find((name) => name === value);
}

/** Splits comma-separated values and records each name under `enabled`. */
function collectOverrides(
  values: string[],
  enabled: boolean,
  overrides: Map<string, boolean>,
): void {
  for (const value of values) {
    for (const entry of value.split(',')) {
      const name = entry.trim();
      if (name) {
        overrides.set(name, enabled);
      }
    }
  }
}

/**
 * Applies the `--enable_features` and `--disable_features` overrides of a
 * command to the process-wide feature registry.
 *
 * Both flags are repeatable and each value may list several names. A name
 * given to both flags ends up disabled, because the disable pass is applied
 * last. An unknown name warns on stderr and never fails the command, so a
 * feature that a newer ADK release removed does not break an existing script.
 */
export function applyFeatureOverrides(command: Command): void {
  const options = command.opts<FeatureOptionValues>();
  const overrides = new Map<string, boolean>();
  collectOverrides(options[ENABLE_FEATURES_KEY] ?? [], true, overrides);
  collectOverrides(options[DISABLE_FEATURES_KEY] ?? [], false, overrides);

  for (const [name, enabled] of overrides) {
    const featureName = toFeatureName(name);
    if (featureName === undefined) {
      console.error(
        `WARNING: Unknown feature name '${name}'. Valid names are: ` +
          `${Object.values(FeatureName).join(', ')}`,
      );
      continue;
    }
    overrideFeatureEnabled(featureName, enabled);
  }
}
