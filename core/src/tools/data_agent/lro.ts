/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Polling a Conversational Analytics long-running operation until it finishes.
 *
 * A create, update or delete answers with an operation rather than the
 * resource, so the tool that issued it waits here.
 */

import {formatError} from '../../utils/error_utils.js';
import {isRecord} from '../../utils/object_utils.js';
import {
  GDA_REQUEST_TIMEOUT_SECONDS,
  GdaResponse,
  GdaSession,
  RETRYABLE_STATUS_CODES,
} from './gda_client.js';
import {DataAgentToolError, DataAgentToolResult} from './tool_result.js';


/** Below this much budget another poll cannot finish, so the loop stops. */
const MIN_REMAINING_SECONDS = 0.1;

/** Error codes a failed connection or an expired request timeout reports. */
const CONNECTION_ERROR_CODES: readonly string[] = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'ABORT_ERR',
];

/**
 * The clock the polling loop runs on, so a test can drive a 60-second timeout
 * without waiting for it.
 */
export interface Clock {
  /** Seconds elapsed on a monotonic timeline. */
  now(): number;
  /** Suspends for `seconds`. */
  sleep(seconds: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => performance.now() / 1000,
  sleep: (seconds) =>
    new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
};

/**
 * Whether a failed poll is worth retrying.
 *
 * adk-python matches `requests.ConnectionError` and `requests.Timeout`. There
 * is no equivalent exception hierarchy here, so the classification reads the
 * error code the fetch layer reports.
 */
function isConnectionFailure(err: unknown): boolean {
  if (!isRecord(err)) {
    return false;
  }
  const code = err['code'];
  if (typeof code === 'string' && CONNECTION_ERROR_CODES.includes(code)) {
    return true;
  }
  return err['name'] === 'TimeoutError' || err['name'] === 'AbortError';
}

/** Whether an operation reports itself finished. */
function isDone(operation: Record<string, unknown>): boolean {
  return Boolean(operation['done']);
}

/**
 * Reads a finished operation.
 *
 * @param operation The operation body.
 * @param operationName The name to report on failure, when one is known.
 * @return The success or error the tool returns.
 */
function lroOutcome(
  operation: Record<string, unknown>,
  operationName?: string,
): DataAgentToolResult {
  if (!Object.hasOwn(operation, 'error')) {
    return {
      status: 'SUCCESS',
      response: Object.hasOwn(operation, 'response')
        ? operation['response']
        : operation,
    };
  }
  const error: DataAgentToolError = {
    status: 'ERROR',
    error_details: JSON.stringify(operation['error']),
  };
  if (operationName !== undefined) {
    error.operation_name = operationName;
  }
  return error;
}

/** Parses an operation body, which the caller has already checked is 2xx. */
function parseOperation(text: string): Record<string, unknown> {
  const operation: unknown = JSON.parse(text);
  return isRecord(operation) ? operation : {};
}

/** What {@link awaitLro} needs to interpret and finish a mutation. */
export interface AwaitLroOptions {
  /** The session the mutation was issued on. */
  session: GdaSession;
  /** The API root, already ending in `/v1`. */
  baseUrl: string;
  /** Headers to send with each poll. */
  headers: Record<string, string>;
  /** The mutation's own response. */
  response: GdaResponse;
  /** The clock reading past which the operation is abandoned. */
  deadline: number;
  /** Seconds between two polls. */
  pollIntervalSeconds: number;
  /** The total budget, named in the timeout message. */
  totalTimeoutSeconds: number;
  /** Defaults to the system clock. */
  clock?: Clock;
}

/**
 * Interprets a mutation response and polls the operation until it finishes.
 *
 * A timeout is not a failure: the operation may still be running, so the
 * error carries `operation_name` for a caller that wants to check later.
 *
 * @param options The mutation response and the polling budget.
 * @return The operation's outcome, or the reason polling gave up.
 */
export async function awaitLro(
  options: AwaitLroOptions,
): Promise<DataAgentToolResult> {
  const {
    session,
    baseUrl,
    headers,
    response,
    deadline,
    pollIntervalSeconds,
    totalTimeoutSeconds,
  } = options;
  const clock = options.clock ?? systemClock;

  if (!response.ok) {
    return {
      status: 'ERROR',
      error_details: `API returned error status: ${response.status} ${response.text}`,
    };
  }

  const operation = parseOperation(response.text);
  if (isDone(operation)) {
    return lroOutcome(operation);
  }

  const operationName = operation['name'];
  if (
    typeof operationName !== 'string' ||
    !operationName.includes('/operations/')
  ) {
    // adk-python reads a missing `done` key as done, so an operation that
    // says nothing is reported as the finished resource it looks like.
    if (Object.hasOwn(operation, 'done') && !operation['done']) {
      return {
        status: 'ERROR',
        error_details:
          'Operation is not completed and does not contain a pollable' +
          ` '/operations/' name: ${JSON.stringify(operation)}`,
      };
    }
    return {status: 'SUCCESS', response: operation};
  }

  const pollUrl = `${baseUrl}/${operationName}`;
  for (;;) {
    let remaining = deadline - clock.now();
    if (remaining <= MIN_REMAINING_SECONDS) {
      break;
    }

    let pollResponse: GdaResponse;
    try {
      pollResponse = await session.request({
        method: 'GET',
        url: pollUrl,
        headers,
        timeoutSeconds: Math.min(GDA_REQUEST_TIMEOUT_SECONDS, remaining),
      });
    } catch (err: unknown) {
      const failure: DataAgentToolError = {
        status: 'ERROR',
        error_details: `Polling failed with exception: ${formatError(err)}`,
        operation_name: operationName,
      };
      remaining = deadline - clock.now();
      if (!isConnectionFailure(err) || remaining <= pollIntervalSeconds) {
        return failure;
      }
      await clock.sleep(Math.min(pollIntervalSeconds, remaining));
      continue;
    }

    if (!pollResponse.ok) {
      remaining = deadline - clock.now();
      if (
        RETRYABLE_STATUS_CODES.includes(pollResponse.status) &&
        remaining > pollIntervalSeconds
      ) {
        await clock.sleep(Math.min(pollIntervalSeconds, remaining));
        continue;
      }
      return {
        status: 'ERROR',
        error_details: `Polling failed with status: ${pollResponse.status} ${pollResponse.text}`,
        operation_name: operationName,
      };
    }

    let polled: Record<string, unknown>;
    try {
      polled = parseOperation(pollResponse.text);
    } catch (err: unknown) {
      return {
        status: 'ERROR',
        error_details: `Polling returned invalid JSON: ${formatError(err)}`,
        operation_name: operationName,
      };
    }
    if (isDone(polled)) {
      return lroOutcome(polled, operationName);
    }

    remaining = deadline - clock.now();
    if (remaining <= MIN_REMAINING_SECONDS) {
      break;
    }
    await clock.sleep(Math.min(pollIntervalSeconds, remaining));
  }

  return {
    status: 'ERROR',
    error_details:
      `Operation ${operationName} did not complete within` +
      ` ${totalTimeoutSeconds} seconds. The operation may still be executing` +
      ' asynchronously in the background. Do not retry the operation.',
    operation_name: operationName,
  };
}
