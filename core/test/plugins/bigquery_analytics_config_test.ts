/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '@google/adk';
import {describe, expect, it} from 'vitest';
import type {
  AnalyticsRetryConfig,
  BigQueryLoggerConfig,
} from '../../src/plugins/bigquery_analytics_config.js';
import {resolvePluginOptions} from '../../src/plugins/bigquery_analytics_config.js';

/** Resolves a configuration against the smallest set of valid options. */
function resolve(config: BigQueryLoggerConfig) {
  return resolvePluginOptions({
    projectId: 'p',
    datasetId: 'd',
    config,
  });
}

/** Resolves a configuration carrying only `retryConfig`. */
function resolveRetry(retryConfig: AnalyticsRetryConfig) {
  return resolve({retryConfig});
}

describe('resolvePluginOptions defaults', () => {
  it('fills every writer default in when nothing is configured', () => {
    expect(resolve({}).writer).toMatchObject({
      tableId: 'agent_events',
      location: 'US',
      batchSize: 1,
      flushIntervalMs: 1000,
      shutdownTimeoutMs: 10000,
      queueMaxSize: 10000,
      autoSchemaUpgrade: true,
      createViews: true,
      viewPrefix: 'v',
      retry: {
        maxRetries: 3,
        initialDelayMs: 1000,
        multiplier: 2,
        maxDelayMs: 10000,
      },
    });
  });

  it('keeps the caller values it was given', () => {
    expect(
      resolveRetry({
        maxRetries: 5,
        initialDelayMs: 500,
        multiplier: 3,
        maxDelayMs: 8000,
      }).writer.retry,
    ).toEqual({
      maxRetries: 5,
      initialDelayMs: 500,
      multiplier: 3,
      maxDelayMs: 8000,
    });
  });

  it('turns retrying off outright when every retry value is zero', () => {
    expect(
      resolveRetry({maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0}).writer
        .retry,
    ).toMatchObject({maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0});
  });

  it('resolves autoSchemaUpgrade false without changing anything else', () => {
    expect(resolve({autoSchemaUpgrade: false}).writer.autoSchemaUpgrade).toBe(
      false,
    );
  });
});

describe('resolvePluginOptions counting options', () => {
  it.each<[string, BigQueryLoggerConfig, string]>([
    ['batchSize', {batchSize: 0}, 'batchSize must be an integer of at least 1'],
    [
      'queueMaxSize',
      {queueMaxSize: 0},
      'queueMaxSize must be an integer of at least 1',
    ],
    [
      'batchSize',
      {batchSize: Number.NaN},
      'batchSize must be an integer of at least 1',
    ],
    [
      'queueMaxSize',
      {queueMaxSize: Number.POSITIVE_INFINITY},
      'queueMaxSize must be an integer of at least 1',
    ],
  ])('refuses %s outside its range', (_name, config, message) => {
    expect(() => resolve(config)).toThrow(message);
  });

  it.each<[string, BigQueryLoggerConfig]>([
    ['batchFlushIntervalMs', {batchFlushIntervalMs: Number.NaN}],
    ['batchFlushIntervalMs', {batchFlushIntervalMs: Number.POSITIVE_INFINITY}],
    ['batchFlushIntervalMs', {batchFlushIntervalMs: 0}],
    ['batchFlushIntervalMs', {batchFlushIntervalMs: -1}],
    ['shutdownTimeoutMs', {shutdownTimeoutMs: Number.NaN}],
    ['shutdownTimeoutMs', {shutdownTimeoutMs: Number.NEGATIVE_INFINITY}],
    ['shutdownTimeoutMs', {shutdownTimeoutMs: 0}],
  ])('refuses a %s that is not a positive finite number', (name, config) => {
    expect(() => resolve(config)).toThrow(
      `${name} must be a finite number greater than 0`,
    );
  });

  it('accepts a fractional duration, because Python takes float seconds', () => {
    expect(resolve({batchFlushIntervalMs: 250.5}).writer.flushIntervalMs).toBe(
      250.5,
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, 1.5, -2])(
    'refuses the content limit %s',
    (limit) => {
      expect(() => resolve({maxContentLength: limit})).toThrow(
        'maxContentLength must be an integer of at least 1, or -1 for no limit',
      );
    },
  );

  it('accepts -1 as the unlimited content length', () => {
    expect(resolve({maxContentLength: -1}).config.maxContentLength).toBe(-1);
  });
});

describe('resolvePluginOptions retry options', () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses maxRetries %s',
    (maxRetries) => {
      expect(() => resolveRetry({maxRetries})).toThrow(
        'retryConfig.maxRetries must be an integer of at least 0',
      );
    },
  );

  it.each([-0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses initialDelayMs %s',
    (initialDelayMs) => {
      expect(() => resolveRetry({initialDelayMs})).toThrow(
        'retryConfig.initialDelayMs must be a finite number of at least 0',
      );
    },
  );

  it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses multiplier %s',
    (multiplier) => {
      expect(() => resolveRetry({multiplier})).toThrow(
        'retryConfig.multiplier must be a finite number of at least 1',
      );
    },
  );

  it.each([-1, Number.NaN, Number.NEGATIVE_INFINITY])(
    'refuses maxDelayMs %s',
    (maxDelayMs) => {
      expect(() => resolveRetry({maxDelayMs})).toThrow(
        'retryConfig.maxDelayMs must be a finite number of at least 0',
      );
    },
  );

  it('refuses a maxDelayMs below the initialDelayMs', () => {
    expect(() =>
      resolveRetry({initialDelayMs: 5000, maxDelayMs: 2000}),
    ).toThrow(
      'retryConfig.maxDelayMs must be at least retryConfig.initialDelayMs, ' +
        'got maxDelayMs=2000 initialDelayMs=5000.',
    );
  });

  it('compares maxDelayMs against the default initialDelayMs too', () => {
    expect(() => resolveRetry({maxDelayMs: 500})).toThrow(
      'maxDelayMs=500 initialDelayMs=1000.',
    );
  });

  it('accepts a maxDelayMs equal to the initialDelayMs', () => {
    expect(() =>
      resolveRetry({initialDelayMs: 2000, maxDelayMs: 2000}),
    ).not.toThrow();
  });
});

describe('resolvePluginOptions custom metadata allowlist', () => {
  it('captures nothing when the allowlist is absent', () => {
    const {exact, prefixes} = resolve({}).config.customMetadataAllowlist;
    expect(exact.size).toBe(0);
    expect(prefixes).toEqual([]);
  });

  it('splits exact keys from the entries written with a trailing star', () => {
    const {exact, prefixes} = resolve({
      customMetadataAllowlist: ['a2a:*', 'tenant_id', 'x:y*'],
    }).config.customMetadataAllowlist;
    expect([...exact]).toEqual(['tenant_id']);
    expect(prefixes).toEqual(['a2a:', 'x:y']);
  });

  it('treats a bare star as the prefix that matches every key', () => {
    expect(
      resolve({customMetadataAllowlist: ['*']}).config.customMetadataAllowlist
        .prefixes,
    ).toEqual(['']);
  });
});

describe('resolvePluginOptions payload column denylist', () => {
  it('passes the denied columns to the writer', () => {
    expect([
      ...resolve({payloadColumnDenylist: ['content', 'attributes']}).writer
        .deniedColumns,
    ]).toEqual(['content', 'attributes']);
  });

  it('refuses a protected column', () => {
    expect(() => resolve({payloadColumnDenylist: ['session_id']})).toThrow(
      'payloadColumnDenylist may only contain',
    );
  });

  it('refuses dropping attributes while custom metadata is captured', () => {
    expect(() =>
      resolve({
        payloadColumnDenylist: ['attributes'],
        customMetadataAllowlist: ['a2a:*'],
      }),
    ).toThrow(
      'customMetadataAllowlist captures into the attributes column, but ' +
        'payloadColumnDenylist drops it',
    );
  });

  it('allows dropping attributes when nothing is captured into it', () => {
    expect(() =>
      resolve({
        payloadColumnDenylist: ['attributes'],
        customMetadataAllowlist: [],
      }),
    ).not.toThrow();
  });

  it('allows capturing metadata while another payload column is dropped', () => {
    expect(() =>
      resolve({
        payloadColumnDenylist: ['content_parts'],
        customMetadataAllowlist: ['tenant_id'],
      }),
    ).not.toThrow();
  });
});

describe('resolvePluginOptions error type', () => {
  it.each<[string, BigQueryLoggerConfig]>([
    ['a count outside its range', {batchSize: 0}],
    ['a duration that is not finite', {shutdownTimeoutMs: Number.NaN}],
    ['a retry delay outside its range', {retryConfig: {maxRetries: -1}}],
    ['a protected payload column', {payloadColumnDenylist: ['session_id']}],
    [
      'a denied attributes column that metadata is captured into',
      {payloadColumnDenylist: ['attributes'], customMetadataAllowlist: ['a*']},
    ],
  ])('reports %s as an InputValidationError', (_name, config) => {
    expect(() => resolve(config)).toThrow(InputValidationError);
  });
});

describe('resolvePluginOptions views', () => {
  it('creates views under the default prefix', () => {
    expect(resolve({}).writer).toMatchObject({
      createViews: true,
      viewPrefix: 'v',
    });
  });

  it('keeps the caller prefix', () => {
    expect(resolve({viewPrefix: 'agent'}).writer.viewPrefix).toBe('agent');
  });

  it('turns the views off when asked', () => {
    expect(resolve({createViews: false}).writer.createViews).toBe(false);
  });

  it.each(['', '   '])('refuses the empty view prefix %o', (viewPrefix) => {
    expect(() => resolve({viewPrefix})).toThrow(
      'viewPrefix must not be empty.',
    );
  });
});

describe('resolvePluginOptions target', () => {
  it.each(['', '  '])('refuses the empty projectId %o', (projectId) => {
    expect(() => resolvePluginOptions({projectId, datasetId: 'd'})).toThrow(
      'projectId must not be empty.',
    );
  });

  it.each(['', '  '])('refuses the empty datasetId %o', (datasetId) => {
    expect(() => resolvePluginOptions({projectId: 'p', datasetId})).toThrow(
      'datasetId must not be empty.',
    );
  });

  it('throws InputValidationError, not a bare Error', () => {
    expect(() => resolvePluginOptions({projectId: '', datasetId: 'd'})).toThrow(
      InputValidationError,
    );
  });
});
