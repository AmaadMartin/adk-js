/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ListSessionsResponse} from '@google/adk';

/**
 * Prefix the evaluation runner puts on the id of every session it creates.
 *
 * The value is a wire contract shared with adk-python, which declares it as
 * `EVAL_SESSION_ID_PREFIX` in `cli_eval.py`.
 */
export const EVAL_SESSION_ID_PREFIX = '___eval___session___';

/**
 * Drops the sessions an evaluation run created from a session listing.
 *
 * Those sessions are bookkeeping for the evaluation runner, so a user browsing
 * their own conversations should not see them.
 *
 * The pagination fields are copied over untouched: the session service counted
 * before this filter ran, so `totalItems` keeps reporting what the service
 * stored. adk-python leaves its own count alone in the same way.
 */
export function withoutEvalSessions(
  response: ListSessionsResponse,
): ListSessionsResponse {
  return {
    ...response,
    sessions: response.sessions.filter(
      (session) => !session.id.startsWith(EVAL_SESSION_ID_PREFIX),
    ),
  };
}
