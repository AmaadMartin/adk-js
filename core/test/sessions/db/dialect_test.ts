/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reference tests ported from `google/adk-python` `main`:
 * `src/google/adk/sessions/database_session_service.py`, exercised by
 * `tests/unittests/sessions/test_session_service.py`. The original test names
 * are kept so a reviewer can grep for them there.
 */

import {describe, expect, it} from 'vitest';
import {
  naiveDatetimeOptions,
  usesNaiveDatetime,
} from '../../../src/sessions/db/dialect.js';

/** The dialects adk-python parametrises the reference test over. */
const REFERENCE_NAIVE_DIALECTS = ['sqlite', 'postgresql', 'mysql', 'mariadb'];

describe('usesNaiveDatetime', () => {
  for (const dialect of REFERENCE_NAIVE_DIALECTS) {
    it(`test_database_session_service_uses_naive_datetime_for_dialect[${dialect}]`, () => {
      expect(usesNaiveDatetime(dialect)).toBe(true);
    });
  }

  /**
   * Adapted: adk-python names the dialect `spanner+spanner`, because SQLAlchemy
   * spells a dialect `backend+driver`. adk-js reads the backend name off the
   * open connection, which carries no driver suffix.
   */
  it('test_database_session_service_keeps_timezone_for_spanner', () => {
    expect(usesNaiveDatetime('spanner')).toBe(false);
  });

  it('treats mssql as naive, which adk-python does not enumerate', () => {
    expect(usesNaiveDatetime('mssql')).toBe(true);
  });

  it('treats the postgres URI alias as naive', () => {
    expect(usesNaiveDatetime('postgres')).toBe(true);
  });

  it('reports an unknown backend as zone-aware', () => {
    expect(usesNaiveDatetime('')).toBe(false);
  });
});

describe('naiveDatetimeOptions', () => {
  it('asks a naive backend for UTC', () => {
    expect(naiveDatetimeOptions('mysql')).toEqual({forceUtcTimezone: true});
  });

  it('asks sqlite for UTC, so a zone-less string reads back as UTC', () => {
    expect(naiveDatetimeOptions('sqlite')).toEqual({forceUtcTimezone: true});
  });

  it('leaves a zone-aware backend alone', () => {
    expect(naiveDatetimeOptions('spanner')).toEqual({});
  });
});
