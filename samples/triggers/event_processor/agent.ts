/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Event processor
 *
 * An agent driven by a Pub/Sub push subscription or an Eventarc CloudEvent
 * rather than by a chat turn. The trigger endpoints deliver one JSON message
 * per event, `{"data": ..., "attributes": {...}}`, and create the session.
 *
 * Serve it (offline, no API key):
 *   npx adk api_server --trigger_sources=pubsub,eventarc samples/triggers
 *
 * See samples/triggers/README.md for the curl commands.
 */

import {node, NodeContext, Workflow} from '@google/adk';

interface TriggerDelivery {
  data: unknown;
  attributes: Record<string, string | null>;
}

const describeEventNode = node(
  (_ctx: NodeContext, delivery: string) => {
    const {data, attributes} = JSON.parse(delivery) as TriggerDelivery;
    const source = attributes['ce-source'] ?? 'pub/sub';
    return `Received an event from ${source}: ${JSON.stringify(data)}`;
  },
  {name: 'describe_event_node'},
);

export const rootAgent = new Workflow({
  name: 'event_processor',
  edges: [['START', describeEventNode]],
});
