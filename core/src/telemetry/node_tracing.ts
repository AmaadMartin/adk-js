/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Context as OtelContext} from '@opentelemetry/api';

import type {Event} from '../events/event.js';

/**
 * Telemetry state tied to the lifetime of one node's span.
 *
 * Ported from `google/adk-python` `telemetry/node_tracing.py::TelemetryContext`.
 * Only the value type is ported: adk-js emits its node spans from
 * `core/src/telemetry/tracing.ts`, so the reference module's span machinery has
 * a counterpart already.
 */
export interface TelemetryContext {
  /** The OTel context that was active when the node started. */
  readonly otelContext: OtelContext;

  /**
   * Ids of the events emitted while the node ran, in emission order.
   *
   * Grows once per event for the lifetime of one node context and is released
   * with it, so it needs no cap — a node that emits without bound has already
   * flooded the event channel.
   */
  readonly associatedEventIds: string[];

  /** Records an event as emitted by this node. */
  addEvent(event: Event): void;
}

/**
 * Creates a {@link TelemetryContext} capturing `otelContext`.
 *
 * @param otelContext The OTel context active when the node started.
 */
export function createTelemetryContext(
  otelContext: OtelContext,
): TelemetryContext {
  const associatedEventIds: string[] = [];
  return {
    otelContext,
    associatedEventIds,
    addEvent(event: Event): void {
      associatedEventIds.push(event.id);
    },
  };
}
