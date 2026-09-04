/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {Context} from '../../agents/context.js';
import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {FunctionTool} from '../function_tool.js';
import {
  getPublisherClient,
  getSubscriberClient,
  PubSubClientRequest,
} from './client.js';
import {PulledMessage, toPulledMessage} from './message_codec.js';
import {PubSubCredentialsManager} from './pubsub_credentials.js';

/** What a Pub/Sub tool answers with when the call fails. */
export interface PubSubErrorResult {
  status: 'ERROR';
  error_details: string;
}

/** What `publish_message` answers with. adk-python reports no status here. */
export interface PublishMessageResult {
  message_id: string;
}

/** What `pull_messages` answers with. adk-python reports no status here. */
export interface PullMessagesResult {
  messages: PulledMessage[];
}

/** What `acknowledge_messages` answers with. */
export interface AcknowledgeMessagesResult {
  status: 'SUCCESS';
}

const publishMessageParams = z.object({
  topic_name: z
    .string()
    .describe(
      'The Pub/Sub topic name, e.g. projects/my-project/topics/my-topic.',
    ),
  message: z.string().describe('The message content to publish.'),
  attributes: z
    .record(z.string(), z.string())
    .optional()
    .describe('Attributes to attach to the message.'),
  ordering_key: z
    .string()
    .default('')
    .describe(
      'Ordering key for the message. A non-empty key makes the topic' +
        ' deliver messages that share it in the order it received them.',
    ),
});

const pullMessagesParams = z.object({
  subscription_name: z
    .string()
    .describe(
      'The Pub/Sub subscription name, e.g.' +
        ' projects/my-project/subscriptions/my-sub.',
    ),
  max_messages: z
    .number()
    .int()
    .positive()
    .default(1)
    .describe('The maximum number of messages to pull. Defaults to 1.'),
  auto_ack: z
    .boolean()
    .default(false)
    .describe(
      'Whether to acknowledge the pulled messages, which removes them from' +
        ' the subscription. Defaults to false.',
    ),
});

const acknowledgeMessagesParams = z.object({
  subscription_name: z
    .string()
    .describe(
      'The Pub/Sub subscription name, e.g.' +
        ' projects/my-project/subscriptions/my-sub.',
    ),
  ack_ids: z
    .array(z.string())
    .describe('The acknowledgement ids of the messages to acknowledge.'),
});

/**
 * Resolves who one tool call speaks as.
 *
 * @param credentials The manager that reads the user's session state.
 * @param projectId Which project the tool works in.
 * @param toolName The tool asking, named in the authorization message.
 * @param context The calling tool's context.
 * @return The client request.
 * @throws Error if the user has not completed the authorization flow.
 */
function clientRequest(
  credentials: PubSubCredentialsManager,
  projectId: string | undefined,
  toolName: string,
  context?: Context,
): PubSubClientRequest {
  const resolved = credentials.resolve(context);
  if (!resolved) {
    throw new Error(
      'User authorization is required to access Google services for' +
        ` ${toolName}. Please complete the authorization flow.`,
    );
  }
  return {credentials: resolved, projectId};
}

/**
 * Runs one tool body and turns any failure into an `ERROR` result.
 *
 * A Pub/Sub tool never throws: the model receives a rejected remote call, a
 * missing peer dependency and a pending authorization in the same envelope,
 * and can read the reason.
 *
 * @param errorPrefix What failed, naming the topic or the subscription.
 * @param call The tool body.
 * @return Whatever the body answered, or the failure under `ERROR`.
 */
async function runPubSubTool<T extends object>(
  errorPrefix: string,
  call: () => Promise<T>,
): Promise<T | PubSubErrorResult> {
  try {
    return await call();
  } catch (err: unknown) {
    const details = `${errorPrefix}: ${formatError(err)}`;
    logger.error(details);
    return {status: 'ERROR', error_details: details};
  }
}

/**
 * Builds the `publish_message` tool.
 *
 * @param credentials Resolves the calling end user's credentials.
 * @param projectId Which project the tool publishes in.
 * @return The tool.
 */
export function createPublishMessageTool(
  credentials: PubSubCredentialsManager,
  projectId: string | undefined,
): FunctionTool<typeof publishMessageParams> {
  const name = 'publish_message';
  return new FunctionTool({
    name,
    description: 'Publish a message to a Pub/Sub topic.',
    parameters: publishMessageParams,
    execute(args, toolContext) {
      return runPubSubTool(
        `Failed to publish message to topic '${args.topic_name}'`,
        async () => {
          const request = clientRequest(
            credentials,
            projectId,
            name,
            toolContext,
          );
          const client = await getPublisherClient(request);
          const [response] = await client.publish({
            topic: args.topic_name,
            messages: [
              {
                data: Buffer.from(args.message, 'utf-8'),
                attributes: args.attributes,
                orderingKey: args.ordering_key,
              },
            ],
          });
          const messageId = response.messageIds?.[0];
          if (!messageId) {
            throw new Error('Pub/Sub accepted the message but returned no id.');
          }
          const result: PublishMessageResult = {message_id: messageId};
          return result;
        },
      );
    },
  });
}

/**
 * Builds the `pull_messages` tool.
 *
 * @param credentials Resolves the calling end user's credentials.
 * @param projectId Which project the tool pulls in.
 * @return The tool.
 */
export function createPullMessagesTool(
  credentials: PubSubCredentialsManager,
  projectId: string | undefined,
): FunctionTool<typeof pullMessagesParams> {
  const name = 'pull_messages';
  return new FunctionTool({
    name,
    description:
      'Pull messages from a Pub/Sub subscription. Set auto_ack to' +
      ' acknowledge them, which removes them from the subscription.',
    parameters: pullMessagesParams,
    execute(args, toolContext) {
      const subscription = args.subscription_name;
      return runPubSubTool(
        `Failed to pull messages from subscription '${subscription}'`,
        async () => {
          const request = clientRequest(
            credentials,
            projectId,
            name,
            toolContext,
          );
          const client = await getSubscriberClient(request);
          const [response] = await client.pull({
            subscription,
            maxMessages: args.max_messages,
          });
          const messages = (response.receivedMessages ?? []).map(
            toPulledMessage,
          );
          const ackIds = messages
            .map((message) => message.ack_id)
            .filter((ackId) => ackId !== '');
          if (args.auto_ack && ackIds.length > 0) {
            await client.acknowledge({subscription, ackIds});
          }
          const result: PullMessagesResult = {messages};
          return result;
        },
      );
    },
  });
}

/**
 * Builds the `acknowledge_messages` tool.
 *
 * @param credentials Resolves the calling end user's credentials.
 * @param projectId Which project the tool acknowledges in.
 * @return The tool.
 */
export function createAcknowledgeMessagesTool(
  credentials: PubSubCredentialsManager,
  projectId: string | undefined,
): FunctionTool<typeof acknowledgeMessagesParams> {
  const name = 'acknowledge_messages';
  return new FunctionTool({
    name,
    description: 'Acknowledge messages on a Pub/Sub subscription.',
    parameters: acknowledgeMessagesParams,
    execute(args, toolContext) {
      const subscription = args.subscription_name;
      return runPubSubTool(
        `Failed to acknowledge messages on subscription '${subscription}'`,
        async () => {
          const request = clientRequest(
            credentials,
            projectId,
            name,
            toolContext,
          );
          const client = await getSubscriberClient(request);
          await client.acknowledge({subscription, ackIds: args.ack_ids});
          const result: AcknowledgeMessagesResult = {status: 'SUCCESS'};
          return result;
        },
      );
    },
  });
}
