/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseSessionService,
  InMemorySessionService,
  getServiceRegistry,
  getSessionServiceFromUri,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

// The process-wide registry has no unregister API, so this scheme is unique to
// this file.
const CUSTOM_SCHEME = 'customsessiontest';

describe('Registry', () => {
  describe('getSessionServiceFromUri', () => {
    it('should return InMemorySessionService for "memory://" uri', () => {
      const service = getSessionServiceFromUri('memory://');
      expect(service).to.be.instanceOf(InMemorySessionService);
    });

    it('should throw error for unsupported uri', () => {
      expect(() =>
        getSessionServiceFromUri('unsupported://localhost:5432/mydb'),
      ).to.throw(
        'Unsupported session service URI: unsupported://localhost:5432/mydb',
      );
    });

    it('should serve a scheme registered on the process-wide registry', () => {
      const service = {} as BaseSessionService;
      const factory = vi.fn().mockReturnValue(service);
      getServiceRegistry().registerSessionService(CUSTOM_SCHEME, factory);

      const resolved = getSessionServiceFromUri(`${CUSTOM_SCHEME}://db/x`, {
        agentsDir: '/agents',
      });

      expect(resolved).toBe(service);
      expect(factory).toHaveBeenCalledExactlyOnceWith(
        `${CUSTOM_SCHEME}://db/x`,
        {agentsDir: '/agents'},
      );
    });

    it('should redact a password in the unsupported uri message', () => {
      expect(() =>
        getSessionServiceFromUri('unsupported://user:hunter2@localhost/db'),
      ).to.throw(
        'Unsupported session service URI: unsupported://user:***@localhost/db',
      );
    });
  });
});
