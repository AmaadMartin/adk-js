/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context as OtelContext} from '@opentelemetry/api';

import {Event} from '../events/event.js';

/**
 * Telemetry state tied to the lifetime of one node run.
 *
 * Port of the `TelemetryContext` dataclass in `google/adk-python`
 * `src/google/adk/telemetry/node_tracing.py`. It holds the OpenTelemetry
 * context that was active when the node's context was built, and the ids of
 * the events the node emitted while it ran, so an exporter can attribute those
 * events to the node's span after the fact.
 */
export class TelemetryContext {
  private readonly eventIds: string[] = [];

  /**
   * @param otelContext The OpenTelemetry context holding the node's span.
   */
  constructor(readonly otelContext: OtelContext) {}

  /** Records an event this node emitted. */
  addEvent(event: Event): void {
    this.eventIds.push(event.id);
  }

  /** Ids of the events this node emitted, in emission order. */
  get associatedEventIds(): readonly string[] {
    return this.eventIds;
  }
}
