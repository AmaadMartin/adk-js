/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LockMode} from '@mikro-orm/core';
import {describe, expect, it} from 'vitest';
import {
  naiveDatetimeOptions,
  sessionLockMode,
  supportsRowLevelLocking,
  usesNaiveDatetime,
} from '../../../src/sessions/db/dialect.js';

/**
 * The dialects adk-python parametrises
 * `test_database_session_service_uses_naive_datetime_for_dialect` over, in
 * `tests/unittests/sessions/test_session_service.py` on `main`.
 */
const REFERENCE_NAIVE_DIALECTS = [
  'sqlite',
  'postgresql',
  'mysql',
  'mariadb',
  'mssql',
] as const;

describe('usesNaiveDatetime', () => {
  for (const dialect of REFERENCE_NAIVE_DIALECTS) {
    it(`test_database_session_service_uses_naive_datetime_for_dialect[${dialect}]`, () => {
      expect(usesNaiveDatetime(dialect)).toBe(true);
    });
  }

  // adk-python spells the dialect `spanner+spanner`, because SQLAlchemy names
  // a dialect `backend+driver`. adk-js reads a bare backend name.
  it('test_database_session_service_keeps_timezone_for_spanner', () => {
    expect(usesNaiveDatetime('spanner')).toBe(false);
  });

  it('answers true for the postgres URI alias', () => {
    expect(usesNaiveDatetime('postgres')).toBe(true);
  });

  it('answers false for a backend it cannot identify', () => {
    expect(usesNaiveDatetime('')).toBe(false);
    expect(usesNaiveDatetime('oracle')).toBe(false);
  });
});

describe('naiveDatetimeOptions', () => {
  it('asks a naive-datetime backend for UTC', () => {
    expect(naiveDatetimeOptions('mysql')).toEqual({forceUtcTimezone: true});
  });

  it('asks a zone-aware backend for nothing', () => {
    expect(naiveDatetimeOptions('spanner')).toEqual({});
  });

  it('asks an unknown backend for nothing', () => {
    expect(naiveDatetimeOptions('')).toEqual({});
  });
});

const LOCKING_BACKENDS = ['mariadb', 'mysql', 'postgresql', 'postgres'];
const NON_LOCKING_BACKENDS = ['sqlite', 'mssql', 'spanner', ''];

describe('supportsRowLevelLocking', () => {
  for (const backend of LOCKING_BACKENDS) {
    it(`locks a row on ${backend}`, () => {
      expect(supportsRowLevelLocking(backend)).toBe(true);
    });
  }

  for (const backend of NON_LOCKING_BACKENDS) {
    it(`does not lock a row on ${backend || 'an unnamed backend'}`, () => {
      expect(supportsRowLevelLocking(backend)).toBe(false);
    });
  }
});

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
