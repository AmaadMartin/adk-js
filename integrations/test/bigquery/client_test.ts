/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigQueryOptions} from '@google-cloud/bigquery';
import {version} from '@google/adk-integrations';
import {PassThroughClient} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {getBigQueryClient} from '../../src/bigquery/client.js';

const bq = vi.hoisted(() => ({clients: [] as BigQueryOptions[]}));

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: class {
    constructor(options: BigQueryOptions) {
      bq.clients.push(options);
    }
  },
}));

const BASE_USER_AGENT = `adk-bigquery-tool google-adk/${version}`;

/** The options the one client built by a test was constructed with. */
function onlyClient(): BigQueryOptions {
  expect(bq.clients).toHaveLength(1);
  return bq.clients[0];
}

describe('getBigQueryClient', () => {
  beforeEach(() => {
    bq.clients.length = 0;
  });

  it('identifies itself as the ADK BigQuery tool', () => {
    getBigQueryClient({project: 'my-project'});

    expect(onlyClient().userAgent).toBe(BASE_USER_AGENT);
  });

  it('appends one extra user-agent part', () => {
    getBigQueryClient({project: 'my-project', userAgent: ['my-app']});

    expect(onlyClient().userAgent).toBe(`${BASE_USER_AGENT} my-app`);
  });

  it('appends several extra user-agent parts in order', () => {
    getBigQueryClient({
      project: 'my-project',
      userAgent: ['my-app', 'execute_sql'],
    });

    expect(onlyClient().userAgent).toBe(
      `${BASE_USER_AGENT} my-app execute_sql`,
    );
  });

  it('drops an undefined or empty user-agent part', () => {
    getBigQueryClient({
      project: 'my-project',
      userAgent: [undefined, '', 'execute_sql'],
    });

    expect(onlyClient().userAgent).toBe(`${BASE_USER_AGENT} execute_sql`);
  });

  it('forwards the project, the location and the auth client', () => {
    const authClient = new PassThroughClient();

    getBigQueryClient({
      project: 'my-project',
      authClient,
      location: 'us-central1',
    });

    const options = onlyClient();
    expect(options.projectId).toBe('my-project');
    expect(options.location).toBe('us-central1');
    expect(options.authClient).toBe(authClient);
  });

  it('leaves the location unset when the caller pins none', () => {
    getBigQueryClient({project: 'my-project'});

    expect(onlyClient().location).toBeUndefined();
  });
});
