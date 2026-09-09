/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isEqual} from 'lodash-es';

import {RESERVED_FUNCTION_CALL_NAMES} from '../agents/framework_function_calls.js';
import {Event, getFunctionCalls, getFunctionResponses} from './event.js';
import {createEventActions} from './event_actions.js';

/**
 * What an event carries that a client may not supply when it initializes a
 * session, or `undefined` when the event is acceptable.
 *
 * Ordinary tool calls and responses pass on purpose, so a conversation that
 * used tools can be restored. `EventActions` is compared against a default
 * instance rather than field by field, so the rule stays correct as
 * `EventActions` gains fields.
 */
function disallowedContent(event: Event): string | undefined {
  if (event.longRunningToolIds?.length) {
    return 'long-running tool IDs';
  }
  if (!isEqual(event.actions, createEventActions())) {
    return 'event actions';
  }
  const functionNames = [
    ...getFunctionCalls(event),
    ...getFunctionResponses(event),
  ].map((call) => call.name);
  if (
    functionNames.some((name) => name && RESERVED_FUNCTION_CALL_NAMES.has(name))
  ) {
    return 'ADK protocol function calls';
  }
  return undefined;
}

/**
 * The reason `events` cannot initialize a session, or `undefined` when they
 * can.
 *
 * A client may restore a conversation, but it may not forge the framework's own
 * runtime signals: long-running tool markers, event actions, and the
 * control-plane function calls ADK raises to ask a human to approve, to
 * authenticate, or to answer.
 *
 * Mirrors `adk-python`
 * `src/google/adk/cli/api_server.py::_validate_session_initialization_events`,
 * which raises instead of returning. Returning the reason leaves the HTTP
 * status choice with the caller.
 *
 * @param events The client-supplied events, already normalized by
 *   {@link createEvent}.
 * @return The reason naming the first offending event's zero-based index, or
 *   undefined when every event is acceptable.
 */
export function sessionInitEventError(events: Event[]): string | undefined {
  for (const [index, event] of events.entries()) {
    const disallowed = disallowedContent(event);
    if (disallowed) {
      return `Session initialization event ${index} cannot include ${disallowed}.`;
    }
  }
  return undefined;
}
