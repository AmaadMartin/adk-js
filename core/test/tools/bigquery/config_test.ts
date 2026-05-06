/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  BigQueryToolConfigSchema,
  WriteMode,
} from '../../../src/tools/bigquery/config.js';

describe('BigQueryToolConfig', () => {
  it('should parse empty config with defaults', () => {
    const config = BigQueryToolConfigSchema.parse({});
    expect(config.writeMode).toBe(WriteMode.BLOCKED);
    expect(config.maxQueryResultRows).toBe(50);
  });

  it('should validate maximumBytesBilled', () => {
    expect(() =>
      BigQueryToolConfigSchema.parse({maximumBytesBilled: 1000}),
    ).toThrow();
    expect(
      BigQueryToolConfigSchema.parse({maximumBytesBilled: 10485760})
        .maximumBytesBilled,
    ).toBe(10485760);
  });

  it('should validate applicationName', () => {
    expect(() =>
      BigQueryToolConfigSchema.parse({applicationName: 'Invalid Name'}),
    ).toThrow();
    expect(
      BigQueryToolConfigSchema.parse({applicationName: 'ValidName'})
        .applicationName,
    ).toBe('ValidName');
  });

  it('should validate jobLabels', () => {
    expect(() =>
      BigQueryToolConfigSchema.parse({
        jobLabels: {'adk-bigquery-label': 'val'},
      }),
    ).toThrow();
    expect(() =>
      BigQueryToolConfigSchema.parse({jobLabels: {'': 'val'}}),
    ).toThrow();

    const largeLabels = Object.fromEntries(
      Array.from({length: 21}, (_, i) => [`label${i}`, 'val']),
    );
    expect(() =>
      BigQueryToolConfigSchema.parse({jobLabels: largeLabels}),
    ).toThrow();

    const validLabels = {'valid-label': 'val'};
    expect(
      BigQueryToolConfigSchema.parse({jobLabels: validLabels}).jobLabels,
    ).toEqual(validLabels);
  });
});
