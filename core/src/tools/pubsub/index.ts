/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `@google/adk/tools/pubsub` subpath: the Pub/Sub tools only, without the
 * full ADK barrel.
 *
 * This is the only entry point. `@google/adk` does not re-export it, so an
 * application that never touches Pub/Sub does not carry
 * `@google-cloud/pubsub` in its bundle.
 */

// Only what a caller configuring or reading a `PubSubToolset` names. The
// credentials manager, the client cache and the tool factories stay internal
// to this module.
export type {PulledMessage} from './message_codec.js';
export type {
  AcknowledgeMessagesResult,
  PubSubErrorResult,
  PublishMessageResult,
  PullMessagesResult,
} from './message_tool.js';
export {PUBSUB_DEFAULT_SCOPES} from './pubsub_credentials.js';
export type {PubSubCredentialsConfig} from './pubsub_credentials.js';
export * from './pubsub_toolset.js';
export type {ServiceAccountCredentials} from './sdk.js';
