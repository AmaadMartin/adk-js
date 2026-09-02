/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {cloneDeep} from 'lodash-es';

import {State} from '../sessions/state.js';

import {File} from './code_execution_utils.js';

const CONTEXT_KEY = '_code_execution_context';
const SESSION_ID_KEY = 'execution_session_id';
const PROCESSED_FILE_NAMES_KEY = 'processed_input_files';
const INPUT_FILE_KEY = '_code_executor_input_files';
const ERROR_COUNT_KEY = '_code_executor_error_counts';
const CODE_EXECUTION_RESULTS_KEY = '_code_execution_results';

/** The mime type a stored input file falls back to when it declares none. */
const DEFAULT_MIME_TYPE = 'text/plain';

/** The shape stored under `_code_execution_context`. */
type CodeExecutionContextData = {
  [SESSION_ID_KEY]?: string;
  [PROCESSED_FILE_NAMES_KEY]?: string[];
};

/** An input file as it is persisted in session state. */
type StoredInputFile = Omit<File, 'mimeType'> & {mimeType?: string};

interface CodeExecutionResult {
  code: string;
  resultStdout: string;
  resultStderr: string;
  timestamp: number;
}

/** Rebuilds a {@link File} from the record persisted in session state. */
function toFile(storedFile: StoredInputFile): File {
  return {...storedFile, mimeType: storedFile.mimeType ?? DEFAULT_MIME_TYPE};
}

/**
 * The parameters for updating the code execution result.
 * */
export interface UpdateCodeExecutionResultParams {
  invocationId: string;
  code: string;
  resultStdout: string;
  resultStderr: string;
}

/**
 * The persistent context used to configure the code executor.
 */
export class CodeExecutorContext {
  private readonly context: CodeExecutionContextData;

  constructor(private readonly sessionState: State) {
    const storedContext =
      sessionState.get<CodeExecutionContextData>(CONTEXT_KEY);

    if (storedContext) {
      this.context = storedContext;
      return;
    }

    // Store the context up front so that later mutations of it are visible
    // through the session state, and are recorded in the delta.
    this.context = {};
    sessionState.set(CONTEXT_KEY, this.context);
  }

  /**
   * Gets the state delta to update in the persistent session state.
   * @return The state delta to update in the persistent session state.
   */
  getStateDelta(): Record<string, unknown> {
    return {
      [CONTEXT_KEY]: cloneDeep(this.context),
    };
  }

  /**
   * Gets the execution ID for the code executor.
   * @return The execution ID for the code executor.
   */
  getExecutionId(): string | undefined {
    if (!(SESSION_ID_KEY in this.context)) {
      return undefined;
    }

    return this.context[SESSION_ID_KEY];
  }

  /**
   * Sets the execution ID for the code executor.
   * @param executionId The execution ID to set.
   */
  setExecutionId(executionId: string) {
    this.context[SESSION_ID_KEY] = executionId;
  }

  /**
   * Gets the processed file names from the session state.
   * @return A list of processed file names in the code executor context.
   */
  getProcessedFileNames(): string[] {
    if (!(PROCESSED_FILE_NAMES_KEY in this.context)) {
      return [];
    }

    return this.context[PROCESSED_FILE_NAMES_KEY]!;
  }

  /**
   * Adds the processed file names to the session state.
   * @param fileNames The file names to add to the session state.
   */
  addProcessedFileNames(fileNames: string[]) {
    if (!(PROCESSED_FILE_NAMES_KEY in this.context)) {
      this.context[PROCESSED_FILE_NAMES_KEY] = [];
    }

    this.context[PROCESSED_FILE_NAMES_KEY]!.push(...fileNames);
  }

  /**
   * Gets the input files from the session state.
   * @return A list of input files in the code executor context.
   */
  getInputFiles(): File[] {
    const storedFiles =
      this.sessionState.get<StoredInputFile[]>(INPUT_FILE_KEY);

    if (!storedFiles) {
      return [];
    }

    return storedFiles.map(toFile);
  }

  /**
   * Adds the input files to the session state.
   * @param inputFiles The input files to add to the session state.
   */
  addInputFiles(inputFiles: File[]) {
    const storedFiles =
      this.sessionState.get<StoredInputFile[]>(INPUT_FILE_KEY) ?? [];

    this.sessionState.set(INPUT_FILE_KEY, [
      ...storedFiles,
      ...inputFiles.map((inputFile) => ({...inputFile})),
    ]);
  }

  clearInputFiles() {
    if (this.sessionState.has(INPUT_FILE_KEY)) {
      this.sessionState.set(INPUT_FILE_KEY, []);
    }

    if (PROCESSED_FILE_NAMES_KEY in this.context) {
      this.context[PROCESSED_FILE_NAMES_KEY] = [];
    }
  }

  /**
   * Gets the error count from the session state.
   * @param invocationId The invocation ID to get the error count for.
   * @return The error count for the given invocation ID.
   */
  getErrorCount(invocationId: string): number {
    const errorCounts = this.readErrorCounts();

    return errorCounts?.[invocationId] ?? 0;
  }

  private readErrorCounts(): Record<string, number> | undefined {
    return this.sessionState.get<Record<string, number>>(ERROR_COUNT_KEY);
  }

  /**
   * Increments the error count from the session state.
   * @param invocationId The invocation ID to increment the error count for.
   */
  incrementErrorCount(invocationId: string) {
    const errorCounts = this.readErrorCounts() ?? {};

    this.sessionState.set(ERROR_COUNT_KEY, {
      ...errorCounts,
      [invocationId]: this.getErrorCount(invocationId) + 1,
    });
  }

  /**
   * Resets the error count from the session state.
   * @param invocationId The invocation ID to reset the error count for.
   */
  resetErrorCount(invocationId: string) {
    const errorCounts = this.readErrorCounts();

    if (!errorCounts) {
      return;
    }

    const remainingCounts = {...errorCounts};
    delete remainingCounts[invocationId];
    this.sessionState.set(ERROR_COUNT_KEY, remainingCounts);
  }

  /**
   * Updates the code execution result.
   * @param invocationId The invocation ID to update the code execution result
   *     for.
   * @param code The code to execute.
   * @param resultStdout The standard output of the code execution.
   * @param resultStderr The standard error of the code execution.
   */
  updateCodeExecutionResult({
    invocationId,
    code,
    resultStdout,
    resultStderr,
  }: UpdateCodeExecutionResultParams) {
    const storedResults =
      this.sessionState.get<Record<string, CodeExecutionResult[]>>(
        CODE_EXECUTION_RESULTS_KEY,
      ) ?? {};

    this.sessionState.set(CODE_EXECUTION_RESULTS_KEY, {
      ...storedResults,
      [invocationId]: [
        ...(storedResults[invocationId] ?? []),
        {
          code,
          resultStdout,
          resultStderr,
          timestamp: Math.floor(Date.now() / 1000),
        },
      ],
    });
  }

  /**
   * Gets the code execution context from the session state.
   * @return The code execution context for the given invocation ID.
   */
  getCodeExecutionContext(): Record<string, unknown> {
    return this.context;
  }
}
