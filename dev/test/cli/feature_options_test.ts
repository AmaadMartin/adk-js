/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  isFeatureEnabled,
  overrideFeatureEnabled,
} from '@google/adk';
import {Command} from 'commander';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  applyFeatureOverrides,
  DISABLE_FEATURES_OPTION,
  ENABLE_FEATURES_OPTION,
} from '../../src/cli/feature_options.js';

const FEATURE = FeatureName.PROGRESSIVE_SSE_STREAMING;

describe('feature_options', () => {
  let stderr: string[];

  beforeEach(() => {
    stderr = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      stderr.push(args.join(' '));
    });
  });

  afterEach(() => {
    // The registry is process-wide, so an override would leak between tests.
    overrideFeatureEnabled(FEATURE, undefined);
    vi.restoreAllMocks();
  });

  /** Parses the flags on a bare command and applies whatever they collected. */
  const applyFlags = (args: string[]) => {
    const command = new Command('run')
      .addOption(ENABLE_FEATURES_OPTION)
      .addOption(DISABLE_FEATURES_OPTION);
    command.parse(['node', 'run', ...args]);
    applyFeatureOverrides(command);
  };

  it('leaves the registry untouched when no flag is given', () => {
    applyFlags([]);

    expect(isFeatureEnabled(FEATURE)).toBe(false);
    expect(stderr).toEqual([]);
  });

  it('enables a feature', () => {
    applyFlags([`--enable_features=${FEATURE}`]);

    expect(isFeatureEnabled(FEATURE)).toBe(true);
  });

  it('disables a feature', () => {
    overrideFeatureEnabled(FEATURE, true);

    applyFlags([`--disable_features=${FEATURE}`]);

    expect(isFeatureEnabled(FEATURE)).toBe(false);
  });

  it('accepts a comma-separated list', () => {
    applyFlags([`--enable_features=UNKNOWN_ONE,${FEATURE}`]);

    expect(isFeatureEnabled(FEATURE)).toBe(true);
    expect(stderr.join('')).toContain("Unknown feature name 'UNKNOWN_ONE'");
  });

  it('accepts the flag more than once', () => {
    applyFlags([
      '--enable_features=UNKNOWN_ONE',
      `--enable_features=${FEATURE}`,
    ]);

    expect(isFeatureEnabled(FEATURE)).toBe(true);
    expect(stderr.join('')).toContain("Unknown feature name 'UNKNOWN_ONE'");
  });

  it('trims whitespace and ignores empty entries', () => {
    applyFlags([`--enable_features=  ,  ${FEATURE}  ,`]);

    expect(isFeatureEnabled(FEATURE)).toBe(true);
    expect(stderr).toEqual([]);
  });

  it('disables a feature that is also enabled', () => {
    applyFlags([
      `--enable_features=${FEATURE}`,
      `--disable_features=${FEATURE}`,
    ]);

    expect(isFeatureEnabled(FEATURE)).toBe(false);
  });

  it('warns on stderr for an unknown name and keeps going', () => {
    applyFlags([`--enable_features=NOT_A_FEATURE,${FEATURE}`]);

    expect(stderr.join('')).toBe(
      "WARNING: Unknown feature name 'NOT_A_FEATURE'. Valid names are: " +
        `${Object.values(FeatureName).join(', ')}`,
    );
    expect(isFeatureEnabled(FEATURE)).toBe(true);
  });

  it('names the enabled feature in the help of both flags', () => {
    expect(ENABLE_FEATURES_OPTION.description).toContain(
      `--enable_features=${FEATURE}`,
    );
    expect(DISABLE_FEATURES_OPTION.description).toContain(
      `--disable_features=${FEATURE}`,
    );
  });
});
