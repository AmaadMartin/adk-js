/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {vi} from 'vitest';

/**
 * Builds a stand-in for the MCP SDK `Client`, which a unit test cannot
 * construct. Every client double goes through here, so the one unavoidable
 * cast lives in a single place.
 *
 * `connect` and `close` resolve by default; pass the members the test needs.
 */
export function clientStub(members: Partial<Client> = {}): Client {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...members,
  } as unknown as Client;
}
