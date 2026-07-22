/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  cleanupClients,
  getPublisherClient,
  getSubscriberClient,
} from '../../../src/tools/pubsub/client.js';
import {PubSubToolset} from '../../../src/tools/pubsub/pubsub_toolset.js';

// Mock the pubsub v1 clients
vi.mock('@google-cloud/pubsub', () => {
  const PublisherClient = vi.fn().mockImplementation(() => {
    return {
      publish: vi.fn(),
      close: vi.fn(),
    };
  });
  const SubscriberClient = vi.fn().mockImplementation(() => {
    return {
      pull: vi.fn(),
      acknowledge: vi.fn(),
      close: vi.fn(),
    };
  });
  return {
    v1: {
      PublisherClient,
      SubscriberClient,
    },
  };
});

describe('PubSubToolset', () => {
  let toolset: PubSubToolset;

  beforeEach(async () => {
    await cleanupClients();
    toolset = new PubSubToolset({
      pubsubToolConfig: {projectId: 'test-project'},
      credentialsConfig: {projectId: 'test-project-auth'},
    });
  });

  afterEach(async () => {
    await toolset.close();
  });

  it('should return publish, pull, and acknowledge tools', async () => {
    const tools = await toolset.getTools();
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name);
    expect(names).toContain('publish_message');
    expect(names).toContain('pull_messages');
    expect(names).toContain('acknowledge_messages');
  });

  describe('publishMessage tool', () => {
    it('should successfully publish a message', async () => {
      const tools = await toolset.getTools();
      const publishTool = tools.find((t) => t.name === 'publish_message') as {
        execute: (
          input: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };

      const pubClient = getPublisherClient();
      vi.mocked(pubClient.publish).mockResolvedValue([
        {messageIds: ['msg-123']},
      ]);

      const result = await publishTool.execute({
        topicName: 'test-topic',
        message: 'hello world',
      });

      expect(result).toEqual({messageId: 'msg-123'});
      expect(pubClient.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          topic: 'test-topic',
        }),
      );
    });

    it('should return ERROR status when publish fails', async () => {
      const tools = await toolset.getTools();
      const publishTool = tools.find((t) => t.name === 'publish_message') as {
        execute: (
          input: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };

      const pubClient = getPublisherClient();
      vi.mocked(pubClient.publish).mockRejectedValue(
        new Error('Publish timeout'),
      );

      const result = await publishTool.execute({
        topicName: 'test-topic',
        message: 'hello world',
      });

      expect(result.status).toEqual('ERROR');
      expect(result.error_details).toContain('Publish timeout');
    });
  });

  describe('pullMessages tool', () => {
    it('should successfully pull messages', async () => {
      const tools = await toolset.getTools();
      const pullTool = tools.find((t) => t.name === 'pull_messages') as {
        execute: (
          input: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };

      const subClient = getSubscriberClient();
      vi.mocked(subClient.pull).mockResolvedValue([
        {
          receivedMessages: [
            {
              ackId: 'ack-123',
              message: {
                messageId: 'msg-123',
                data: Buffer.from('hello from sub', 'utf8'),
                attributes: {key: 'val'},
                publishTime: {seconds: 1672531200, nanos: 0},
              },
            },
          ],
        },
      ]);

      const result = await pullTool.execute({
        subscriptionName: 'test-sub',
        maxMessages: 5,
        autoAck: false,
      });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].data).toEqual('hello from sub');
      expect(result.messages[0].attributes).toEqual({key: 'val'});
    });

    it('should autoAck messages if autoAck is true', async () => {
      const tools = await toolset.getTools();
      const pullTool = tools.find((t) => t.name === 'pull_messages') as {
        execute: (
          input: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };

      const subClient = getSubscriberClient();
      vi.mocked(subClient.pull).mockResolvedValue([
        {
          receivedMessages: [
            {
              ackId: 'ack-123',
              message: {
                messageId: 'msg-123',
                data: Buffer.from('hello', 'utf8'),
              },
            },
          ],
        },
      ]);

      await pullTool.execute({
        subscriptionName: 'test-sub',
        maxMessages: 1,
        autoAck: true,
      });

      expect(subClient.acknowledge).toHaveBeenCalledWith({
        subscription: 'test-sub',
        ackIds: ['ack-123'],
      });
    });

    it('should return ERROR status when pull fails', async () => {
      const tools = await toolset.getTools();
      const pullTool = tools.find((t) => t.name === 'pull_messages') as {
        execute: (
          input: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };

      const subClient = getSubscriberClient();
      vi.mocked(subClient.pull).mockRejectedValue(new Error('Pull timeout'));

      const result = await pullTool.execute({
        subscriptionName: 'test-sub',
      });

      expect(result.status).toEqual('ERROR');
      expect(result.error_details).toContain('Pull timeout');
    });
  });

  describe('acknowledgeMessages tool', () => {
    it('should successfully acknowledge messages', async () => {
      const tools = await toolset.getTools();
      const ackTool = tools.find((t) => t.name === 'acknowledge_messages') as {
        execute: (
          input: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };

      const subClient = getSubscriberClient();
      vi.mocked(subClient.acknowledge).mockResolvedValue([{}]);

      const result = await ackTool.execute({
        subscriptionName: 'test-sub',
        ackIds: ['ack-1', 'ack-2'],
      });

      expect(result.status).toEqual('SUCCESS');
      expect(subClient.acknowledge).toHaveBeenCalledWith({
        subscription: 'test-sub',
        ackIds: ['ack-1', 'ack-2'],
      });
    });

    it('should return ERROR status when acknowledge fails', async () => {
      const tools = await toolset.getTools();
      const ackTool = tools.find((t) => t.name === 'acknowledge_messages') as {
        execute: (
          input: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };

      const subClient = getSubscriberClient();
      vi.mocked(subClient.acknowledge).mockRejectedValue(
        new Error('Ack timeout'),
      );

      const result = await ackTool.execute({
        subscriptionName: 'test-sub',
        ackIds: ['ack-1'],
      });

      expect(result.status).toEqual('ERROR');
      expect(result.error_details).toContain('Ack timeout');
    });
  });
});
