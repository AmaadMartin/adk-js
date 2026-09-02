/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemorySessionService, getSessionServiceFromUri} from '@google/adk';
import {describe, expect, it} from 'vitest';

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

    it('explains a driver suffix rather than disclaiming the uri', () => {
      expect(() =>
        getSessionServiceFromUri('postgresql+asyncpg://user:pw@host:5432/db'),
      ).to.throw("names the 'asyncpg' driver in its scheme");
    });
  });
});
