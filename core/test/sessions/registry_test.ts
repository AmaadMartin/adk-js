/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemorySessionService,
  RedisSessionService,
  getSessionServiceFromUri,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('Registry', () => {
  describe('getSessionServiceFromUri', () => {
    it('should return InMemorySessionService for "memory://" uri', () => {
      const service = getSessionServiceFromUri('memory://');
      expect(service).to.be.instanceOf(InMemorySessionService);
    });

    it('should return RedisSessionService for "redis://" uri', () => {
      const service = getSessionServiceFromUri('redis://localhost:6379/0');
      expect(service).to.be.instanceOf(RedisSessionService);
    });

    it('should return RedisSessionService for "rediss://" uri', () => {
      const service = getSessionServiceFromUri('rediss://localhost:6380');
      expect(service).to.be.instanceOf(RedisSessionService);
    });

    it('should throw error for unsupported uri', () => {
      expect(() =>
        getSessionServiceFromUri('unsupported://localhost:5432/mydb'),
      ).to.throw(
        'Unsupported session service URI: unsupported://localhost:5432/mydb',
      );
    });
  });
});
