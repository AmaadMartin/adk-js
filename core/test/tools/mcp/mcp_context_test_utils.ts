/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {vi} from 'vitest';

/**
 * Builds an MCP `Client` test double.
 *
 * `Client` is a class with private state, so no object literal satisfies it
 * structurally. The cast every stub needs is confined to this one helper
 * instead of being repeated at each stub site.
 *
 * @param parts The client methods the test under exercise actually calls.
 * @return The stub, typed as a `Client`.
 */
export function clientStub(parts: Partial<Client>): Client {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...parts,
  } as Client;
}
