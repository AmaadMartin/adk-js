/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The slice of `@google-cloud/eventarc-publishing` this module talks to, and
 * the lazy loader that fetches it.
 *
 * The package is close to a megabyte and pulls in `google-gax`, so it is an
 * optional peer dependency: only `import type` appears at the top level here,
 * and the value import is deferred to {@link loadEventarcSdk}.
 */

import type * as eventarc from '@google-cloud/eventarc-publishing';
import {loadOptionalPeer} from '../../utils/optional_peer.js';

/** The npm package backing the Eventarc tools. */
const EVENTARC_PACKAGE = '@google-cloud/eventarc-publishing';

/** The ADK feature named in the "not installed" error. */
const EVENTARC_FEATURE = 'EventarcToolset';

/** A CloudEvent in the wire shape the publishing API accepts. */
export type CloudEvent =
  eventarc.protos.google.cloud.eventarc.publishing.v1.ICloudEvent;

/** One CloudEvent attribute value, of which only `ceString` is used here. */
export type CloudEventAttributeValue =
  eventarc.protos.google.cloud.eventarc.publishing.v1.CloudEvent.ICloudEventAttributeValue;

/** A request to publish one CloudEvent to a message bus. */
export type PublishRequest =
  eventarc.protos.google.cloud.eventarc.publishing.v1.IPublishRequest;

/**
 * A service-account key, as Google's client libraries read it. The field
 * names are the ones in a downloaded key file, so they stay snake_case.
 */
export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

/** An authorized-user credential, as `gcloud auth` writes it. */
export interface AuthorizedUserCredentials {
  type: 'authorized_user';
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

/**
 * A credential body handed to the SDK.
 *
 * Credentials cross this boundary as data, never as a built `AuthClient`:
 * `google-gax` pins its own major of `google-auth-library`, so a client object
 * built against the copy `@google/adk` depends on is not interchangeable with
 * the one the SDK expects.
 */
export type EventarcSdkCredentials =
  | ServiceAccountCredentials
  | AuthorizedUserCredentials;

/** The publishing SDK's module surface. */
export type EventarcSdk = typeof eventarc;

/** The options the SDK's publisher client accepts. */
export type PublisherClientOptions = NonNullable<
  ConstructorParameters<EventarcSdk['PublisherClient']>[0]
>;

/** The publisher-client methods this module calls. */
export interface PublisherClient {
  publish(
    request: PublishRequest,
    options?: {timeout?: number},
  ): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Loads `@google-cloud/eventarc-publishing` on first use.
 *
 * @return The publishing SDK.
 * @throws If the package is not installed, an error naming it and the
 *   `npm install` command that fixes it.
 */
export function loadEventarcSdk(): Promise<EventarcSdk> {
  return loadOptionalPeer(
    {packageName: EVENTARC_PACKAGE, feature: EVENTARC_FEATURE},
    () => import('@google-cloud/eventarc-publishing'),
  );
}
