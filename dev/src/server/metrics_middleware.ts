/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RequestMetricsDriver} from '@google/adk';
import {RequestHandler} from 'express';
import type {EventEmitter} from 'node:events';

import {AdkLogger} from '../utils/logger.js';

const logger = new AdkLogger({label: 'Metrics', colorize: {all: true}});

/**
 * Drives `reader` from one request: a collect on entry, a drain on completion.
 *
 * Neither collect is awaited, so metrics never add latency to the response.
 * The drain runs on `finish` for a normal response and on `close` for a client
 * abort or a handler that threw. Either way it runs exactly once, so the
 * in-flight count cannot leak.
 */
export function driveRequestMetrics(
  reader: RequestMetricsDriver,
  res: EventEmitter,
): void {
  // A metrics failure must never break the request it rides on.
  try {
    if (reader.noteRequestStart()) {
      void reader.submitCollect();
    }
  } catch (e: unknown) {
    logger.warn('Metrics request-start hook failed', e);
  }
  let drained = false;
  const drain = () => {
    if (drained) {
      return;
    }
    drained = true;
    try {
      if (reader.noteRequestEnd()) {
        void reader.submitCollect();
      }
    } catch (e: unknown) {
      logger.warn('Failed to flush metrics on request end', e);
    }
  };
  res.once('finish', drain);
  res.once('close', drain);
}

/** Express middleware that drives the request-driven metric reader. */
export function metricsFlushingMiddleware(
  reader: RequestMetricsDriver,
): RequestHandler {
  return (_req, res, next) => {
    driveRequestMetrics(reader, res);
    next();
  };
}
