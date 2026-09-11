/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LockMode} from '@mikro-orm/core';
import {describe, expect, it} from 'vitest';
import {sessionLockMode} from '../../../src/sessions/db/dialect.js';

const LOCKING_BACKENDS = ['mariadb', 'mysql', 'postgresql', 'postgres'];
const NON_LOCKING_BACKENDS = ['sqlite', 'mssql', 'spanner', ''];

describe('sessionLockMode', () => {
  for (const backend of LOCKING_BACKENDS) {
    it(`takes a write lock on ${backend}`, () => {
      expect(sessionLockMode(backend)).toBe(LockMode.PESSIMISTIC_WRITE);
    });
  }

  for (const backend of NON_LOCKING_BACKENDS) {
    it(`takes no lock on ${backend || 'an unnamed backend'}`, () => {
      expect(sessionLockMode(backend)).toBeUndefined();
    });
  }
});
