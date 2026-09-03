/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client, ClientFactory} from '@a2a-js/sdk/client';

/** The two `Client` methods `RemoteA2AAgent` calls. */
export type FakeClientMethods = Pick<
  Client,
  'sendMessage' | 'sendMessageStream'
>;

/**
 * A `Client` double carrying only the methods the agent calls.
 *
 * `Client` and `ClientFactory` are concrete SDK classes with a dozen members
 * and private state, so a partial double cannot satisfy them structurally.
 * This is the one place that cast lives; every A2A test imports these two
 * builders rather than repeating it.
 */
export function fakeA2AClient(methods: FakeClientMethods): Client {
  return methods as unknown as Client;
}

/** A `ClientFactory` double that always hands back `client`. */
export function fakeClientFactory(
  createFromAgentCard: (card: unknown) => Promise<Client>,
): ClientFactory {
  return {createFromAgentCard} as unknown as ClientFactory;
}
