/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Publishing CloudEvents to Google Cloud Eventarc Advanced.
 *
 * `@google-cloud/eventarc-publishing` backs these tools and is an optional
 * peer dependency, reached only through a dynamic import, so importing this
 * module does not require it to be installed.
 */

export {cleanupClients} from './client.js';
export {DEFAULT_PUBLISH_TIMEOUT_MS, type EventarcToolConfig} from './config.js';
export {
  AgentProvided,
  OMIT,
  buildDomainSpecificTool,
  type AttributeBinding,
  type AttributeResolver,
  type CloudEventAttributesBinding,
  type CreatePublishToolOptions,
  type DomainSpecificToolOptions,
} from './domain_specific_publish.js';
export {
  validateEventarcCredentialsConfig,
  type EventarcCredentialsConfig,
} from './eventarc_credentials.js';
export {
  EventarcToolset,
  PUBLISH_MESSAGE_TOOL_NAME,
  type EventarcToolsetOptions,
} from './eventarc_toolset.js';
export {
  EventarcPublishStatus,
  publishMessage,
  publishMessageSchema,
  type PublishMessageInput,
  type PublishMessageOptions,
  type PublishMessageResult,
} from './message_tool.js';
export type {
  AuthorizedUserCredentials,
  EventarcSdkCredentials,
  ServiceAccountCredentials,
} from './sdk.js';
