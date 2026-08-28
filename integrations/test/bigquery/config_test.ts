/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {WriteMode, resolveBigQueryToolConfig} from '@google/adk-integrations';
import {describe, expect, it} from 'vitest';

/** The smallest byte cap BigQuery on-demand pricing accepts. */
const MINIMUM_BYTES_BILLED = 10_485_760;

describe('resolveBigQueryToolConfig', () => {
  it('blocks writes and caps the result at 50 rows by default', () => {
    const config = resolveBigQueryToolConfig();

    expect(config.writeMode).toBe(WriteMode.BLOCKED);
    expect(config.maxQueryResultRows).toBe(50);
  });

  it('keeps the defaults for an empty configuration', () => {
    const config = resolveBigQueryToolConfig({});

    expect(config.writeMode).toBe(WriteMode.BLOCKED);
    expect(config.maxQueryResultRows).toBe(50);
  });

  it('keeps the row cap the caller set', () => {
    const config = resolveBigQueryToolConfig({maxQueryResultRows: 100});

    expect(config.maxQueryResultRows).toBe(100);
  });

  it('keeps the write mode the caller set', () => {
    const config = resolveBigQueryToolConfig({writeMode: WriteMode.ALLOWED});

    expect(config.writeMode).toBe(WriteMode.ALLOWED);
  });

  it('carries every other setting through unchanged', () => {
    const config = resolveBigQueryToolConfig({
      location: 'us-central1',
      computeProjectId: 'compute-project',
      applicationName: 'my-app',
      jobLabels: {environment: 'test'},
      maximumBytesBilled: MINIMUM_BYTES_BILLED,
    });

    expect(config.location).toBe('us-central1');
    expect(config.computeProjectId).toBe('compute-project');
    expect(config.applicationName).toBe('my-app');
    expect(config.jobLabels).toEqual({environment: 'test'});
    expect(config.maximumBytesBilled).toBe(MINIMUM_BYTES_BILLED);
  });

  it('accepts the smallest byte cap BigQuery bills', () => {
    const config = resolveBigQueryToolConfig({
      maximumBytesBilled: MINIMUM_BYTES_BILLED,
    });

    expect(config.maximumBytesBilled).toBe(MINIMUM_BYTES_BILLED);
  });

  it('rejects a byte cap one byte below the minimum', () => {
    expect(() =>
      resolveBigQueryToolConfig({
        maximumBytesBilled: MINIMUM_BYTES_BILLED - 1,
      }),
    ).toThrowError(
      'In BigQuery on-demand pricing, charges are rounded up to the nearest' +
        ' MB, with a minimum 10 MB data processed per table referenced by the' +
        ' query, and with a minimum 10 MB data processed per query. So' +
        ' max_bytes_billed must be set >=10485760.',
    );
  });

  it('accepts a zero byte cap, as adk-python does', () => {
    const config = resolveBigQueryToolConfig({maximumBytesBilled: 0});

    expect(config.maximumBytesBilled).toBe(0);
  });

  it('rejects an application name that contains a space', () => {
    expect(() =>
      resolveBigQueryToolConfig({applicationName: 'my agent'}),
    ).toThrowError('Application name should not contain spaces.');
  });

  it('accepts job labels', () => {
    const config = resolveBigQueryToolConfig({
      jobLabels: {environment: 'test', team: 'data'},
    });

    expect(config.jobLabels).toEqual({environment: 'test', team: 'data'});
  });

  it('accepts an empty label set', () => {
    const config = resolveBigQueryToolConfig({jobLabels: {}});

    expect(config.jobLabels).toEqual({});
  });

  it('accepts no label set at all', () => {
    const config = resolveBigQueryToolConfig({location: 'US'});

    expect(config.jobLabels).toBeUndefined();
  });

  it('rejects an empty label key', () => {
    expect(() =>
      resolveBigQueryToolConfig({jobLabels: {'': 'value'}}),
    ).toThrowError('Label keys cannot be empty.');
  });

  it('rejects a label key ADK reserves', () => {
    expect(() =>
      resolveBigQueryToolConfig({jobLabels: {'adk-bigquery-mine': 'value'}}),
    ).toThrowError(
      'Label key cannot start with "adk-bigquery-" as it is reserved for ' +
        'internal usage, found "adk-bigquery-mine".',
    );
  });

  it('accepts 20 labels', () => {
    const jobLabels = Object.fromEntries(
      Array.from({length: 20}, (_unused, index) => [`key${index}`, 'value']),
    );

    expect(resolveBigQueryToolConfig({jobLabels}).jobLabels).toEqual(jobLabels);
  });

  it('rejects 21 labels', () => {
    const jobLabels = Object.fromEntries(
      Array.from({length: 21}, (_unused, index) => [`key${index}`, 'value']),
    );

    expect(() => resolveBigQueryToolConfig({jobLabels})).toThrowError(
      'Only up to 20 job labels can be provided',
    );
  });
});
