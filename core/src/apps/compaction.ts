/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isLlmAgent} from '../agents/llm_agent.js';
import {
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';
import {Session} from '../sessions/session.js';
import {
  buildCompactionAttributes,
  buildCompactionResultAttributes,
  tracer,
} from '../telemetry/tracing.js';
import {RunnableRoot} from '../workflow/run_node_as_invocation.js';

import {BaseEventsSummarizer} from './base_events_summarizer.js';
import {EventsCompactionConfig} from './events_compaction_config.js';
import {LlmEventSummarizer} from './llm_event_summarizer.js';

/** The trigger name recorded on the compaction span. */
const SLIDING_WINDOW_TRIGGER = 'sliding_window';

/**
 * Returns the ids that `event` opens an obligation for: every function call it
 * issues, plus every tool confirmation and auth credential it requests.
 */
function openedIds(event: Event): string[] {
  const ids = getFunctionCalls(event)
    .map((call) => call.id)
    .filter((id): id is string => Boolean(id));
  ids.push(
    ...Object.keys(event.actions.requestedToolConfirmations),
    ...Object.keys(event.actions.requestedAuthConfigs),
  );
  return ids;
}

/**
 * Returns the longest prefix of `events` that is safe to summarize.
 *
 * One left-to-right pass tracks the obligations still open by call id. An
 * event's function responses are applied before its calls, so a response only
 * closes an obligation an *earlier* event opened. A prefix is safe only where
 * nothing is open, so the longest prefix ending at such a point is returned —
 * empty when the window never balances.
 *
 * This is what keeps a half-finished tool exchange, a pending confirmation or
 * an open auth request out of a summary.
 *
 * Mirrors `google/adk-python` `_longest_self_contained_prefix`.
 */
export function longestSelfContainedPrefix(events: Event[]): Event[] {
  const open = new Set<string>();
  let safeLength = 0;
  events.forEach((event, index) => {
    for (const response of getFunctionResponses(event)) {
      if (response.id) {
        open.delete(response.id);
      }
    }
    for (const id of openedIds(event)) {
      open.add(id);
    }
    if (open.size === 0) {
      safeLength = index + 1;
    }
  });
  return events.slice(0, safeLength);
}

/**
 * Returns the end timestamp of the newest compaction in the stream, or `0`.
 *
 * Mirrors the reverse scan `google/adk-python`
 * `_run_compaction_for_sliding_window` performs.
 */
function lastCompactedEndTimestamp(events: Event[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const endTimestamp = events[i].actions.compaction?.endTimestamp;
    if (endTimestamp) {
      return endTimestamp;
    }
  }
  return 0;
}

/**
 * Returns the events of the window to summarize, in stream order.
 *
 * Empty when too few new invocations have completed since the last compaction,
 * or when the window holds no self-contained prefix.
 */
function selectWindow(
  events: Event[],
  config: EventsCompactionConfig,
): Event[] {
  const lastEnd = lastCompactedEndTimestamp(events);

  const latestTimestamps = new Map<string, number>();
  for (const event of events) {
    if (!event.invocationId || event.actions.compaction) {
      continue;
    }
    latestTimestamps.set(
      event.invocationId,
      Math.max(latestTimestamps.get(event.invocationId) ?? 0, event.timestamp),
    );
  }

  const invocationIds = [...latestTimestamps.keys()];
  const newInvocationIds = [...latestTimestamps.entries()]
    .filter(([, timestamp]) => timestamp > lastEnd)
    .map(([id]) => id);
  if (newInvocationIds.length < config.compactionInterval) {
    return [];
  }

  const startIndex = Math.max(
    0,
    invocationIds.indexOf(newInvocationIds[0]) - config.overlapSize,
  );
  const startInvocationId = invocationIds[startIndex];
  const endInvocationId = newInvocationIds[newInvocationIds.length - 1];

  // Both ids came out of `invocationIds`, which was built from these events,
  // so both bounds are always found.
  const eventInvocationIds = events.map((event) => event.invocationId);
  const firstIndex = eventInvocationIds.indexOf(startInvocationId);
  const lastIndex = eventInvocationIds.lastIndexOf(endInvocationId);

  return longestSelfContainedPrefix(
    events
      .slice(firstIndex, lastIndex + 1)
      .filter((event) => !event.actions.compaction),
  );
}

/**
 * Returns the summarizer to compact with.
 *
 * @throws Error when no summarizer is configured and the root cannot supply a
 *   model to build the default one from.
 */
function resolveSummarizer(
  config: EventsCompactionConfig,
  rootAgent: RunnableRoot,
): BaseEventsSummarizer {
  if (config.summarizer) {
    return config.summarizer;
  }
  if (!isLlmAgent(rootAgent)) {
    throw new Error(
      'No LlmAgent model available for event compaction summarizer.',
    );
  }
  return new LlmEventSummarizer({llm: rootAgent.canonicalModel});
}

/** Parameters for {@link runCompactionForSlidingWindow}. */
export interface RunCompactionForSlidingWindowParams {
  config: EventsCompactionConfig;
  rootAgent: RunnableRoot;
  session: Session;
}

/**
 * Compacts a sliding window of session events once enough new invocations have
 * completed.
 *
 * The window ends at the last new invocation and starts `overlapSize`
 * invocations before the first new one, so consecutive summaries overlap and
 * keep context. It is then trimmed to its longest self-contained prefix.
 *
 * With `compactionInterval = 2` and `overlapSize = 1`: after invocations 1 and
 * 2 complete, a summary covering 1-2 is produced. Nothing happens after
 * invocation 3 alone. After invocation 4 the next summary covers 2-4, since the
 * overlap reaches one invocation back from the new block.
 *
 * Mirrors `google/adk-python` `_run_compaction_for_sliding_window`. It yields
 * rather than appends, so persistence stays at the runner's single append site.
 *
 * @param params The compaction config, the app's root, and the session to read.
 * @yields The compaction event, if the summarizer produced one.
 */
export async function* runCompactionForSlidingWindow(
  params: RunCompactionForSlidingWindowParams,
): AsyncGenerator<Event, void, void> {
  const {config, rootAgent, session} = params;
  const window = selectWindow(session.events, config);
  if (window.length === 0) {
    return;
  }

  const summarizer = resolveSummarizer(config, rootAgent);
  const span = tracer.startSpan(`compact_events ${SLIDING_WINDOW_TRIGGER}`);
  let compactionEvent: Event | undefined;
  try {
    span.setAttributes(
      buildCompactionAttributes({
        sessionId: session.id,
        trigger: SLIDING_WINDOW_TRIGGER,
        summarizerType: summarizer.constructor.name,
        eventCount: window.length,
        compactionInterval: config.compactionInterval,
        overlapSize: config.overlapSize,
      }),
    );
    compactionEvent = await summarizer.maybeSummarizeEvents(window);
    span.setAttributes(buildCompactionResultAttributes(compactionEvent));
  } finally {
    span.end();
  }

  if (compactionEvent) {
    yield compactionEvent;
  }
}
