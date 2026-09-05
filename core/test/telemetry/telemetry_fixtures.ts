/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogAttributes} from '@opentelemetry/api-logs';
import {emptyResource, Resource} from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  LogRecordProcessor,
  SdkLogRecord,
} from '@opentelemetry/sdk-logs';
import {gaxios, OAuth2Client} from 'google-auth-library';
import {expect, vi} from 'vitest';

/**
 * Auth client that signs telemetry exports with a fixed bearer token.
 *
 * It extends `OAuth2Client` so that it is assignable wherever
 * `GoogleAuth.getClient()` resolves. `request` rejects by default, which is the
 * Cloud Resource Manager lookup failing; a test that needs it to succeed spies
 * on the method.
 */
export class FakeAuthClient extends OAuth2Client {
  /** Bearer token handed out next. A test can change it mid-flight. */
  constructor(public token = 'test-token') {
    super();
  }

  override async getRequestHeaders(): Promise<Headers> {
    return new Headers({authorization: `Bearer ${this.token}`});
  }

  override request<T>(_options: gaxios.GaxiosOptions): gaxios.GaxiosPromise<T> {
    return Promise.reject(new Error('The Cloud Resource Manager is offline.'));
  }
}

/** Builds the HTTP response `AuthClient.request` resolves with. */
export function gaxiosResponse(data: unknown): gaxios.GaxiosResponse<unknown> {
  const url = new URL('https://cloudresourcemanager.googleapis.com/');
  return Object.assign(new Response(JSON.stringify(data), {status: 200}), {
    config: {headers: new Headers(), url},
    data,
  });
}

/** What one emitted record looks like to the processor and to the batcher. */
export interface EmittedRecords {
  /** The record the provider handed to every registered processor. */
  incoming: SdkLogRecord;
  /** The record the processor forwarded to the batching base class. */
  forwarded: SdkLogRecord;
}

/**
 * Emits one log record through `processor` and returns both views of it.
 *
 * The record travels the real `LoggerProvider` path. A second processor
 * registered alongside sees the record as it was handed over, which is what
 * the "does not mutate" assertion compares against.
 */
export function emitLogRecord(
  processor: LogRecordProcessor,
  options: {
    resource?: Resource;
    eventName?: string;
    attributes?: LogAttributes;
  } = {},
): EmittedRecords {
  const incoming: SdkLogRecord[] = [];
  const observer: LogRecordProcessor = {
    onEmit: (record) => {
      incoming.push(record);
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
  const forwarded: SdkLogRecord[] = [];
  const batched = vi
    .spyOn(BatchLogRecordProcessor.prototype, 'onEmit')
    .mockImplementation((record) => {
      forwarded.push(record);
    });

  try {
    const provider = new LoggerProvider({
      resource: options.resource ?? emptyResource(),
      processors: [observer, processor],
    });
    provider.getLogger('test').emit({
      body: 'a log line',
      eventName: options.eventName,
      attributes: options.attributes,
    });
  } finally {
    batched.mockRestore();
  }

  expect(incoming).toHaveLength(1);
  expect(forwarded).toHaveLength(1);
  return {incoming: incoming[0], forwarded: forwarded[0]};
}
