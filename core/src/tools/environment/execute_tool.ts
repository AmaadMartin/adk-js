/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import {Context} from '../../agents/context.js';
import {BaseEnvironment} from '../../environment/base_environment.js';
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

const EXECUTE_TOOL_DESCRIPTION = `
Run a shell command in the environment. For running programs, tests, and build
commands ONLY. WARNING: Do NOT use for file reading -- use the ReadFile tool
instead. Shell commands like 'cat, head, tail will produce inferior results.
Good: Execute("python3 script.py"), Execute("pytest"), Execute("find ...").
Bad: Execute("head ..."), Execute("cat ...").
`;

/** Options for {@link ExecuteTool}. */
export interface ExecuteToolOptions {
  /** Character cap applied to stdout and stderr. */
  maxOutputChars?: number;
}

/** Run a shell command in the environment's working directory. */
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

    const confirmationResult = enforceConfirmation(toolContext, command);
    if (confirmationResult) {
      return confirmationResult;
    }

    logger.debug(`Execute command: ${command}`);
    let executionResult;
    try {
      executionResult = await this.environment.execute(
        command,
        DEFAULT_TIMEOUT_SECONDS,
      );
    } catch (e: unknown) {
      return {status: 'error', error: formatError(e)};
    }

    const result: Record<string, unknown> = {status: 'ok'};
    if (executionResult.stdout) {
      result['stdout'] = truncate(executionResult.stdout, this.maxOutputChars);
    }
    if (executionResult.stderr) {
      result['stderr'] = truncate(executionResult.stderr, this.maxOutputChars);
    }
    if (executionResult.exitCode !== 0) {
      result['status'] = 'error';
      result['exit_code'] = executionResult.exitCode;
    }
    if (executionResult.timedOut) {
      result['status'] = 'error';
      result['error'] = `Command timed out after ${DEFAULT_TIMEOUT_SECONDS}s.`;
    }
    return result;
  }
}

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
 * @return An intermediate or rejection result, or `undefined` to proceed.
 */
function enforceConfirmation(
  toolContext: Context,
  command: string,
):
  | {partial: string}
  | {status: string; error: string; errorCode: ExecuteToolErrorCode}
  | undefined {
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
