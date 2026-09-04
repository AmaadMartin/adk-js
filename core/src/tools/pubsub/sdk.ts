/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The part of `@google-cloud/pubsub` the tools use.
 *
 * Declaring the shape keeps the boundary narrow and typed: TypeScript checks
 * every declaration below against the real module when {@link loadPubSubSdk}
 * resolves, so a renamed method or a changed result is a build failure rather
 * than a runtime one.
 *
 * Credentials cross this boundary as data, never as an auth client object.
 * The SDK types its `authClient` field against the copy of
 * `google-auth-library` that `google-gax` pins, which is a different major
 * version from the one adk-js depends on, and two copies of that package are
 * never interchangeable because `AuthClient` carries protected members.
 */

import type {protos} from '@google-cloud/pubsub';
import {loadOptionalPeer} from '../../utils/optional_peer.js';

/**
 * An OAuth client the end user authorized, as Google's client libraries read
 * it from `application_default_credentials.json`.
 */
export interface AuthorizedUserCredentials {
  type: 'authorized_user';
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

/** A service-account key, as Google's client libraries read it. */
export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

/** The credentials a Pub/Sub client authenticates with. */
export type PubSubSdkCredentials =
  | AuthorizedUserCredentials
  | ServiceAccountCredentials;

/**
 * The options both clients are built with.
 *
 * A type alias rather than an interface, because the generated clients' own
 * options carry an index signature and only an alias gets the implicit one
 * that makes it assignable.
 */
export type PubSubSdkOptions = {
  projectId?: string;
  /** Left unset to fall back to Application Default Credentials. */
  credentials?: PubSubSdkCredentials;
  /** A service-account key file, read by the SDK. */
  keyFilename?: string;
  scopes?: string[];
  /** Reaches the `x-goog-api-client` header through google-gax. */
  libName: string;
  libVersion: string;
};

/**
 * A protobuf timestamp: whole seconds plus nanoseconds. `seconds` arrives as
 * a `Long` when the response was decoded from the wire.
 */
export type PubSubTimestamp = protos.google.protobuf.ITimestamp;

/** One message a pull answers with, and its acknowledgement id. */
export type PubSubReceivedMessage = protos.google.pubsub.v1.IReceivedMessage;

/** What a synchronous pull answers with. */
export type PubSubPullResponse = protos.google.pubsub.v1.IPullResponse;

/** What a publish answers with. */
export type PubSubPublishResponse = protos.google.pubsub.v1.IPublishResponse;

/**
 * The generated client, which publishes one message per call.
 *
 * The high-level `Topic` batches, which adk-python disables with
 * `BatchSettings(max_messages=1)`. This client issues one unary call, so
 * there is no batch window to disable.
 */
export interface PubSubPublisherClient {
  publish(request: {
    topic: string;
    messages: Array<{
      data: Uint8Array;
      attributes?: Record<string, string>;
      orderingKey?: string;
    }>;
  }): Promise<[PubSubPublishResponse, ...unknown[]]>;
  close(): Promise<void>;
}

/**
 * The generated client, which pulls and acknowledges.
 *
 * The high-level `Subscription` class only streams, so the synchronous calls
 * go through this one.
 */
export interface PubSubSubscriberClient {
  pull(request: {
    subscription: string;
    maxMessages: number;
  }): Promise<[PubSubPullResponse, ...unknown[]]>;
  acknowledge(request: {
    subscription: string;
    ackIds: string[];
  }): Promise<unknown>;
  close(): Promise<void>;
}

/** The module `@google-cloud/pubsub` exports. */
export interface PubSubSdk {
  v1: {
    PublisherClient: new (options: PubSubSdkOptions) => PubSubPublisherClient;
    SubscriberClient: new (options: PubSubSdkOptions) => PubSubSubscriberClient;
  };
}

/** The package and the feature named when the peer is not installed. */
const PUBSUB_PEER = {
  packageName: '@google-cloud/pubsub',
  feature: 'PubSubToolset',
};

/**
 * Loads `@google-cloud/pubsub`.
 *
 * It is an optional peer dependency and is imported only here, so that
 * importing `@google/adk` never resolves it.
 *
 * @return The parts of the SDK the tools use.
 * @throws Error naming the package and the install command when it is missing.
 */
export function loadPubSubSdk(): Promise<PubSubSdk> {
  return loadOptionalPeer(PUBSUB_PEER, () => import('@google-cloud/pubsub'));
}
