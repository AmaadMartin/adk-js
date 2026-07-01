/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {EvalSetResult} from './evaluation_types.js';

/**
 * Error thrown when a requested evaluation result is not found.
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Manages evaluation set results stored locally on the filesystem.
 */
export class LocalEvalSetResultsManager {
  constructor(private readonly agentsDir: string) {}

  private getEvalHistoryDir(appName: string): string {
    validateId(appName, 'App name');
    return path.join(this.agentsDir, appName, '.adk', 'eval_history');
  }

  /**
   * Lists all evaluation set result IDs for a given app.
   *
   * Returns an empty list if the history directory does not exist.
   */
  async listEvalSetResults(appName: string): Promise<string[]> {
    try {
      return (await fs.readdir(this.getEvalHistoryDir(appName)))
        .filter((file) => file.endsWith('.evalset_result.json'))
        .map((file) => file.replace(/\.evalset_result\.json$/, ''));
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Retrieves a specific evaluation set result.
   *
   * Throws NotFoundError if the result does not exist.
   */
  async getEvalSetResult(
    appName: string,
    evalResultId: string,
  ): Promise<EvalSetResult> {
    validateId(evalResultId, 'Eval result ID');
    const filePath = path.join(
      this.getEvalHistoryDir(appName),
      `${evalResultId}.evalset_result.json`,
    );

    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8')) as EvalSetResult;
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        throw new NotFoundError(
          `Eval result not found: ${evalResultId} for app ${appName}`,
        );
      }
      throw error;
    }
  }
}

function validateId(value: string, name: string): void {
  if (!value) {
    throw new Error(`${name} cannot be empty`);
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(value) || value.includes('..')) {
    const lowerName = name.charAt(0).toLowerCase() + name.slice(1);
    throw new Error(`Invalid ${lowerName}: ${value}`);
  }
}
