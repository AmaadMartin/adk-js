/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {Context} from '../../agents/context.js';
import {
  BaseEnvironment,
  ExecutionResult,
} from '../../environment/base_environment.js';
import {formatError} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {REQUIRE_CONFIRMATION_MESSAGE} from '../tool_confirmation.js';
import {DEFAULT_TIMEOUT_SECONDS, MAX_OUTPUT_CHARS} from './constants.js';
import {truncate} from './truncate.js';

/**
 * Error codes returned by {@link ExecuteTool} when a call cannot be completed.
 * The string values are part of the tool's response contract and must remain
 * stable.
 */
export enum ExecuteToolErrorCode {
  CONFIRMATION_REJECTED = 'CONFIRMATION_REJECTED',
}

/**
 * Description shown to the model. Copied verbatim from adk-python's
 * `_EXECUTE_TOOL_DESCRIPTION`, including its punctuation, because the model
 * sees this text and parity keeps the two SDKs behaving alike.
 */
const EXECUTE_TOOL_DESCRIPTION = `
Run a shell command in the environment. For running programs, tests, and build
commands ONLY. WARNING: Do NOT use for file reading -- use the ReadFile tool
instead. Shell commands like 'cat, head, tail will produce inferior results.
Good: Execute("python3 script.py"), Execute("pytest"), Execute("find ...").
Bad: Execute("head ..."), Execute("cat ...").
`;

/** How much of stdout and stderr reaches the debug log. */
const LOGGED_OUTPUT_CHARS = 200;

/** Telemetry error type reported for a failed call. */
const TOOL_ERROR_TYPE = 'TOOL_ERROR';

/** Options for {@link ExecuteTool}. */
export interface ExecuteToolOptions {
  /**
   * Character cap applied to stdout and stderr independently. Defaults to
   * 30000.
   */
  maxOutputChars?: number;
}

/**
 * The object {@link ExecuteTool.runAsync} resolves to once a command has run.
 *
 * The keys are model-facing wire names, so `exit_code` stays snake_case to
 * match adk-python even though the rest of the codebase is camelCase.
 */
interface ExecuteToolResponse {
  status: 'ok' | 'error';
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  error?: string;
}

/**
 * Runs a shell command in a {@link BaseEnvironment}'s working directory.
 *
 * The command runs through {@link BaseEnvironment.execute}, so the host it
 * reaches is whatever environment you pass in. With `LocalEnvironment` that is
 * the developer's machine, unsandboxed, which is why every call is gated
 * behind an explicit client confirmation. There is no way to switch the gate
 * off.
 *
 * The environment must already be initialized. This tool never calls
 * `initialize()` or `close()` on it.
 *
 * A non-zero exit code is a result, not an exception: it comes back as
 * `{status: 'error', exit_code}` alongside whatever the command printed.
 */
@experimental
export class ExecuteTool extends BaseTool {
  private readonly maxOutputChars: number;

  constructor(
    private readonly environment: BaseEnvironment,
    options: ExecuteToolOptions = {},
  ) {
    super({name: 'Execute', description: EXECUTE_TOOL_DESCRIPTION});
    this.maxOutputChars = options.maxOutputChars ?? MAX_OUTPUT_CHARS;
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          command: {
            type: Type.STRING,
            description:
              'The shell command to execute. Chain dependent commands with &&.',
          },
        },
        required: ['command'],
      },
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const command = args['command'];
    if (typeof command !== 'string' || command.length === 0) {
      return {status: 'error', error: '`command` is required.'};
    }

    const refusal = enforceConfirmation(toolContext, command);
    if (refusal) {
      return refusal;
    }

    logger.debug('Execute command:', command);
    let executionResult: ExecutionResult;
    try {
      executionResult = await this.environment.execute(
        command,
        DEFAULT_TIMEOUT_SECONDS,
      );
    } catch (e: unknown) {
      const error = formatError(e);
      logger.error('Execute failed:', error);
      return {status: 'error', error};
    }

    logger.debug(
      'Execute result:',
      `exit_code=${executionResult.exitCode},`,
      `stdout=${JSON.stringify(executionResult.stdout.slice(0, LOGGED_OUTPUT_CHARS))},`,
      `stderr=${JSON.stringify(executionResult.stderr.slice(0, LOGGED_OUTPUT_CHARS))},`,
      `timed_out=${executionResult.timedOut}`,
    );

    const result: ExecuteToolResponse = {status: 'ok'};
    if (executionResult.stdout) {
      result.stdout = truncate(executionResult.stdout, this.maxOutputChars);
    }
    if (executionResult.stderr) {
      result.stderr = truncate(executionResult.stderr, this.maxOutputChars);
    }
    if (executionResult.exitCode !== 0) {
      result.status = 'error';
      result.exit_code = executionResult.exitCode;
    }
    if (executionResult.timedOut) {
      result.status = 'error';
      result.error = `Command timed out after ${DEFAULT_TIMEOUT_SECONDS}s.`;
    }
    return result;
  }

  /**
   * Telemetry hook reporting whether a response describes a failure.
   *
   * It reads `status`, not the presence of an `error` key, so a response
   * carrying only `{error}` is not counted as a tool error.
   *
   * @param response The value {@link runAsync} resolved to.
   * @returns `'TOOL_ERROR'` for a failed call, otherwise `undefined`.
   */
  detectErrorInResponse(response: unknown): string | undefined {
    if (
      typeof response !== 'object' ||
      response === null ||
      !('status' in response)
    ) {
      return undefined;
    }
    return response.status === 'error' ? TOOL_ERROR_TYPE : undefined;
  }
}

/** The result of the confirmation gate, or `undefined` to proceed. */
type ConfirmationRefusal =
  | {partial: string}
  | {status: 'error'; error: string; errorCode: ExecuteToolErrorCode};

/**
 * Enforces a human-in-the-loop confirmation gate before running a command,
 * using the repo's standard tool-confirmation mechanism.
 *
 * adk-python's `ExecuteTool` has no gate. adk-js adds one because the command
 * runs on the host shell with no sandboxing, and `LocalEnvironment` makes
 * gating the caller's responsibility.
 *
 * @param toolContext The context of the current tool call.
 * @param command The shell command the model asked to run.
 * @returns An intermediate result while approval is pending, a rejection error
 *   when the client refused, or `undefined` when the command may run.
 */
function enforceConfirmation(
  toolContext: Context,
  command: string,
): ConfirmationRefusal | undefined {
  const confirmation = toolContext.toolConfirmation;

  if (!confirmation) {
    toolContext.requestConfirmation({
      hint:
        'Confirmation is required before running a shell command in the ' +
        'environment. Only approve if you trust the command:\n\n' +
        command,
      payload: {command},
    });
    return {partial: REQUIRE_CONFIRMATION_MESSAGE};
  }

  if (!confirmation.confirmed) {
    return {
      status: 'error',
      error: 'Command execution was not confirmed and was rejected.',
      errorCode: ExecuteToolErrorCode.CONFIRMATION_REJECTED,
    };
  }

  return undefined;
}
