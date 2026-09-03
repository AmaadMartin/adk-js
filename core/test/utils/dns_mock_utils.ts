/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LookupAddress, LookupAllOptions} from 'node:dns';

import {Mock, vi} from 'vitest';

/**
 * The `{all: true}` form of `dns.lookup`, the only one the url-safety guards
 * call. `lookup` is overloaded, and a mock of the whole symbol resolves to an
 * overload that returns a single address, so it cannot be given an array.
 */
type LookupAll = (
  hostname: string,
  options: LookupAllOptions,
) => Promise<LookupAddress[]>;

/**
 * The stand-in for `dns.lookup`. Install it from the test file, which is where
 * `vi.mock` has to live because it is hoisted per file:
 *
 * ```ts
 * vi.mock('node:dns/promises', async () => ({
 *   lookup: (await import('../utils/dns_mock_utils.js')).lookupMock,
 * }));
 * ```
 */
export const lookupMock: Mock<LookupAll> = vi.fn<LookupAll>();

/** Resolves any hostname to `addresses`. */
export function resolveTo(...addresses: string[]): void {
  lookupMock.mockResolvedValue(
    addresses.map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    })),
  );
}
