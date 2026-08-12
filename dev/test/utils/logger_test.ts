/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LogLevel} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AdkLogger, setDefaultLogLevel} from '../../src/utils/logger.js';

/**
 * `printFormat` is the observation point: winston runs the format pipeline
 * only for a record {@link AdkLogger} did not filter out, so an entry in
 * `messages` means the level gate let the record through.
 */
function createLogger(messages: unknown[]): AdkLogger {
  return new AdkLogger({
    label: 'test',
    printFormat: (info) => {
      messages.push(info.message);
      return '';
    },
  });
}

describe('AdkLogger', () => {
  afterEach(() => {
    setDefaultLogLevel(LogLevel.INFO);
  });

  describe('default level', () => {
    it('drops a debug record at the initial default', () => {
      const messages: unknown[] = [];
      const logger = createLogger(messages);

      logger.debug('hidden');

      expect(messages).toEqual([]);
    });

    it('emits a debug record once the default is DEBUG', async () => {
      const messages: unknown[] = [];
      const logger = createLogger(messages);

      setDefaultLogLevel(LogLevel.DEBUG);
      logger.debug('shown');

      await vi.waitFor(() => expect(messages).toContain('shown'));
    });

    it('applies to a logger built before the default changed', async () => {
      const messages: unknown[] = [];
      // Module loggers are constructed at import time, before the CLI parses
      // its flags, so the level cannot be captured in the constructor.
      const logger = createLogger(messages);

      setDefaultLogLevel(LogLevel.DEBUG);
      logger.debug('late');

      await vi.waitFor(() => expect(messages).toContain('late'));
    });
  });

  describe('explicit level', () => {
    it('wins over a more permissive default', () => {
      const messages: unknown[] = [];
      const logger = createLogger(messages);

      logger.setLogLevel(LogLevel.ERROR);
      setDefaultLogLevel(LogLevel.DEBUG);
      logger.debug('hidden');

      expect(messages).toEqual([]);
    });

    it('wins over a more restrictive default', async () => {
      const messages: unknown[] = [];
      const logger = createLogger(messages);

      logger.setLogLevel(LogLevel.DEBUG);
      setDefaultLogLevel(LogLevel.ERROR);
      logger.debug('shown');

      await vi.waitFor(() => expect(messages).toContain('shown'));
    });
  });
});
