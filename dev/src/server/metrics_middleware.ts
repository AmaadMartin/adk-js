/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {RequestMetricsDriver} from '@google/adk';
import {RequestHandler} from 'express';

import {AdkLogger} from '../utils/logger.js';

const logger = new AdkLogger({label: 'Metrics', colorize: {all: true}});

/** The response completion events the drain hooks onto. */
export interface ResponseCompletion {
  once(event: 'finish' | 'close', listener: () => void): unknown;
}

/**
 * Runs the drain collect once a request is over.
 *
 * It is awaited so the export completes while the request still holds CPU.
 */
export async function drainMetrics(
  reader: RequestMetricsDriver,
): Promise<void> {
  try {
    if (reader.noteRequestEnd()) {
      await reader.submitCollect();
    }
  } catch (e: unknown) {
    logger.warn('Failed to flush metrics on request end', e);
  }
}

/**
 * Drives `reader` from one request: a collect on entry, a drain on completion.
 *
 * The entry collect is not awaited, so it never adds latency to the response.
 * The drain runs on `finish` for a normal response and on `close` for a client
 * abort or a handler that threw. Either way it runs exactly once, so the
 * in-flight count cannot leak.
 */
export function driveRequestMetrics(
  reader: RequestMetricsDriver,
  res: ResponseCompletion,
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
    void drainMetrics(reader);
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
