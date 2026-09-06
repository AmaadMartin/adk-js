/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An in-process stand-in for `@google-cloud/eventarc-publishing`, shared by
 * the Eventarc tests.
 *
 * Install it with a module factory that pulls the class out of this module, so
 * that the test and the mocked package see the same recorder:
 *
 * ```ts
 * vi.mock('@google-cloud/eventarc-publishing', async () => {
 *   const {FakePublisherClient} = await import('./eventarc_test_utils.js');
 *   return {PublisherClient: FakePublisherClient};
 * });
 * ```
 */

import {
  EventarcPublishStatus,
  publishMessage,
  type EventarcToolConfig,
  type PublishMessageInput,
  type PublishMessageResult,
} from '@google/adk';
import type {
  Context as OtelContext,
  TextMapPropagator,
  TextMapSetter,
} from '@opentelemetry/api';
import {expect} from 'vitest';
import type {
  CloudEvent,
  PublisherClientOptions,
  PublishRequest,
} from '../../../src/integrations/eventarc/sdk.js';

/** The trace headers {@link StubPropagator} writes. */
export const STUB_TRACE_HEADERS: Record<string, string> = {
  traceparent: '00-testtrace-testid-01',
  tracestate: 'teststate=1',
};

/**
 * A propagator that writes fixed trace headers, standing in for the W3C one
 * an application installs. adk-python's test patches `inject` the same way.
 */
export class StubPropagator implements TextMapPropagator {
  constructor(private readonly keys = Object.keys(STUB_TRACE_HEADERS)) {}

  inject(
    _context: OtelContext,
    carrier: unknown,
    setter: TextMapSetter<unknown>,
  ): void {
    for (const key of this.keys) {
      setter.set(carrier, key, STUB_TRACE_HEADERS[key]);
    }
  }

  extract(context: OtelContext): OtelContext {
    return context;
  }

  fields(): string[] {
    return this.keys;
  }
}

/** The message bus the tests publish to. */
export const BUS = 'projects/test/locations/global/messageBuses/my-bus';

/** The settings the tests publish with. */
export const SETTINGS: EventarcToolConfig = {projectId: 'test-project'};

/** One recorded call to `publish`. */
export interface RecordedPublish {
  request: PublishRequest;
  options?: {timeout?: number};
}

/** Every fake client built since the last {@link resetEventarcFake}. */
export const builtClients: FakePublisherClient[] = [];

/** What the next `publish` throws, when a test asks it to fail. */
export const publishBehavior: {error?: Error} = {};

/** A publisher client that records what it was asked to do. */
export class FakePublisherClient {
  readonly publishes: RecordedPublish[] = [];
  closeCount = 0;

  constructor(readonly options?: PublisherClientOptions) {
    builtClients.push(this);
  }

  async publish(
    request: PublishRequest,
    options?: {timeout?: number},
  ): Promise<unknown> {
    if (publishBehavior.error !== undefined) {
      throw publishBehavior.error;
    }
    this.publishes.push({request, options});
    return [{}, undefined, undefined];
  }

  async close(): Promise<void> {
    this.closeCount++;
  }
}

/** Clears the recorded clients and any configured publish failure. */
export function resetEventarcFake(): void {
  builtClients.length = 0;
  publishBehavior.error = undefined;
}

/** The single publish recorded across every fake client. */
export function onlyPublish(): RecordedPublish {
  const publishes = builtClients.flatMap((client) => client.publishes);
  expect(publishes).toHaveLength(1);
  return publishes[0];
}

/** The CloudEvent of the single recorded publish. */
export function onlyEvent(): CloudEvent {
  const event = onlyPublish().request.protoMessage;
  if (event === undefined || event === null) {
    expect.fail('the publish request carried no protoMessage');
  }
  return event;
}

/**
 * The recorded event's attributes, flattened to their string values. A key
 * whose value is not a string maps to `undefined`, so an assertion on it
 * fails rather than passing on the wrong attribute kind.
 */
export function eventAttributes(
  event: CloudEvent,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(event.attributes ?? {}).map(([key, value]) => [
      key,
      value.ceString ?? undefined,
    ]),
  );
}

/** Publishes with the shared bus, type, source and settings. */
export async function publish(
  input: Partial<PublishMessageInput> = {},
): Promise<PublishMessageResult> {
  return publishMessage(
    {bus: BUS, type: 'com.example.test', source: '//test/source', ...input},
    {toolConfig: SETTINGS},
  );
}

/** The `error_details` of a result the test expects to be an error. */
export function errorDetails(result: PublishMessageResult): string {
  if (result.status !== EventarcPublishStatus.ERROR) {
    expect.fail(`expected an error result, got ${JSON.stringify(result)}`);
  }
  return result.error_details;
}
