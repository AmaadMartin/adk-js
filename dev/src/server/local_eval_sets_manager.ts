/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {EvalCase, EvalSet} from './evaluation_types.js';

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

const EVAL_SET_FILE_EXTENSION = '.evalset.json';

export function validatePathSegment(value: string, fieldName: string): void {
  if (!value) {
    throw new Error(`${fieldName} must not be empty.`);
  }
  if (value.includes('\0')) {
    throw new Error(`${fieldName} must not contain null bytes.`);
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error(
      `${fieldName} "${value}" must not contain path separators.`,
    );
  }
  if (value === '.' || value === '..') {
    throw new Error(
      `${fieldName} "${value}" must not contain traversal segments.`,
    );
  }
}

function validateId(idName: string, idValue: string): void {
  const pattern = /^[a-zA-Z0-9_]+$/;
  if (!pattern.test(idValue)) {
    throw new Error(
      `Invalid ${idName}. ${idName} should have the "${pattern.source}" format`,
    );
  }
}

function getEvalCaseFromEvalSet(
  evalSet: EvalSet,
  evalCaseId: string,
): EvalCase | undefined {
  return evalSet.evalCases.find((c) => c.evalId === evalCaseId);
}

function addEvalCaseToEvalSet(evalSet: EvalSet, evalCase: EvalCase): EvalSet {
  const evalCaseId = evalCase.evalId;
  if (evalSet.evalCases.some((c) => c.evalId === evalCaseId)) {
    throw new Error(
      `Eval id "${evalCaseId}" already exists in "${evalSet.evalSetId}" eval set.`,
    );
  }
  evalSet.evalCases.push(evalCase);
  return evalSet;
}

function updateEvalCaseInEvalSet(
  evalSet: EvalSet,
  updatedEvalCase: EvalCase,
): EvalSet {
  const evalCaseId = updatedEvalCase.evalId;
  const index = evalSet.evalCases.findIndex((c) => c.evalId === evalCaseId);
  if (index === -1) {
    throw new NotFoundError(
      `Eval case "${evalCaseId}" not found in eval set "${evalSet.evalSetId}".`,
    );
  }
  evalSet.evalCases[index] = updatedEvalCase;
  return evalSet;
}

function deleteEvalCaseFromEvalSet(
  evalSet: EvalSet,
  evalCaseId: string,
): EvalSet {
  const index = evalSet.evalCases.findIndex((c) => c.evalId === evalCaseId);
  if (index === -1) {
    throw new NotFoundError(
      `Eval case "${evalCaseId}" not found in eval set "${evalSet.evalSetId}".`,
    );
  }
  evalSet.evalCases.splice(index, 1);
  return evalSet;
}

async function loadEvalSetFromFile(
  evalSetFilePath: string,
  evalSetId: string,
): Promise<EvalSet> {
  const content = await fsPromises.readFile(evalSetFilePath, 'utf-8');
  const parsed = JSON.parse(content);
  if (Array.isArray(parsed)) {
    return convertOldFormat(evalSetId, parsed);
  }
  return parsed as EvalSet;
}

interface LegacyEvalCase {
  name: string;
  data?: Array<{
    query: string;
    reference?: string;
    expected_tool_use?: Array<{
      tool_name: string;
      tool_input?: Record<string, unknown>;
    }>;
    expected_intermediate_agent_responses?: Array<{
      author: string;
      text: string;
    }>;
  }>;
  initial_session?: {
    app_name?: string;
    user_id?: string;
    state?: Record<string, unknown>;
  };
}

function convertOldFormat(
  evalSetId: string,
  oldCases: LegacyEvalCase[],
): EvalSet {
  const evalCases: EvalCase[] = oldCases.map((oldCase) => {
    const conversation = (oldCase.data || []).map((oldInv) => {
      const expectedToolUse = (oldInv.expected_tool_use || []).map((ot) => ({
        name: ot.tool_name,
        args: ot.tool_input || {},
      }));
      const intermediateResponses = (
        oldInv.expected_intermediate_agent_responses || []
      ).map((oir) => [oir.author, [{text: oir.text}]]);

      return {
        invocationId: randomUUID(),
        userContent: {
          role: 'user',
          parts: [{text: oldInv.query}],
        },
        finalResponse: oldInv.reference
          ? {
              role: 'model',
              parts: [{text: oldInv.reference}],
            }
          : undefined,
        intermediateData: {
          tool_uses: expectedToolUse,
          intermediate_responses: intermediateResponses,
        },
        creationTimestamp: Date.now() / 1000,
      };
    });

    let sessionInput = undefined;
    if (
      oldCase.initial_session &&
      Object.keys(oldCase.initial_session).length > 0
    ) {
      sessionInput = {
        appName: oldCase.initial_session.app_name || '',
        userId: oldCase.initial_session.user_id || '',
        state: oldCase.initial_session.state || {},
      };
    }

    return {
      evalId: oldCase.name,
      conversation,
      sessionInput,
      creationTimestamp: Date.now() / 1000,
    };
  });

  return {
    evalSetId,
    name: evalSetId,
    creationTimestamp: Date.now() / 1000,
    evalCases,
  };
}

export class LocalEvalSetsManager {
  constructor(private readonly agentsDir: string) {}

  private getEvalSetFilePath(appName: string, evalSetId: string): string {
    validatePathSegment(appName, 'appName');
    validatePathSegment(evalSetId, 'evalSetId');
    return path.join(
      this.agentsDir,
      appName,
      evalSetId + EVAL_SET_FILE_EXTENSION,
    );
  }

  async getEvalSet(
    appName: string,
    evalSetId: string,
  ): Promise<EvalSet | undefined> {
    try {
      const filePath = this.getEvalSetFilePath(appName, evalSetId);
      return await loadEvalSetFromFile(filePath, evalSetId);
    } catch (e: unknown) {
      if ((e as {code?: string}).code === 'ENOENT') {
        return undefined;
      }
      throw e;
    }
  }

  async createEvalSet(appName: string, evalSetId: string): Promise<EvalSet> {
    validateId('Eval Set ID', evalSetId);
    const filePath = this.getEvalSetFilePath(appName, evalSetId);

    try {
      await fsPromises.stat(filePath);
      throw new Error(
        `EvalSet ${evalSetId} already exists for app ${appName}.`,
      );
    } catch (e: unknown) {
      if ((e as {code?: string}).code === 'ENOENT') {
        const newEvalSet: EvalSet = {
          evalSetId,
          name: evalSetId,
          evalCases: [],
          creationTimestamp: Date.now() / 1000,
        };
        await this.saveEvalSet(appName, evalSetId, newEvalSet);
        return newEvalSet;
      }
      throw e;
    }
  }

  async listEvalSets(appName: string): Promise<string[]> {
    validatePathSegment(appName, 'appName');
    const appDirPath = path.join(this.agentsDir, appName);
    try {
      const files = await fsPromises.readdir(appDirPath);
      const evalSets = files
        .filter((file) => file.endsWith(EVAL_SET_FILE_EXTENSION))
        .map((file) => path.basename(file, EVAL_SET_FILE_EXTENSION));
      return evalSets.sort();
    } catch (e: unknown) {
      if ((e as {code?: string}).code === 'ENOENT') {
        throw new NotFoundError(
          `Eval directory for app "${appName}" not found.`,
        );
      }
      throw e;
    }
  }

  async getEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<EvalCase | undefined> {
    const evalSet = await this.getEvalSet(appName, evalSetId);
    if (!evalSet) {
      return undefined;
    }
    return getEvalCaseFromEvalSet(evalSet, evalCaseId);
  }

  async addEvalCase(
    appName: string,
    evalSetId: string,
    evalCase: EvalCase,
  ): Promise<void> {
    const evalSet = await this.getEvalSet(appName, evalSetId);
    if (!evalSet) {
      throw new NotFoundError(`Eval set "${evalSetId}" not found.`);
    }
    const updatedEvalSet = addEvalCaseToEvalSet(evalSet, evalCase);
    await this.saveEvalSet(appName, evalSetId, updatedEvalSet);
  }

  async updateEvalCase(
    appName: string,
    evalSetId: string,
    updatedEvalCase: EvalCase,
  ): Promise<void> {
    const evalSet = await this.getEvalSet(appName, evalSetId);
    if (!evalSet) {
      throw new NotFoundError(`Eval set "${evalSetId}" not found.`);
    }
    const updatedEvalSet = updateEvalCaseInEvalSet(evalSet, updatedEvalCase);
    await this.saveEvalSet(appName, evalSetId, updatedEvalSet);
  }

  async deleteEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<void> {
    const evalSet = await this.getEvalSet(appName, evalSetId);
    if (!evalSet) {
      throw new NotFoundError(`Eval set "${evalSetId}" not found.`);
    }
    const updatedEvalSet = deleteEvalCaseFromEvalSet(evalSet, evalCaseId);
    await this.saveEvalSet(appName, evalSetId, updatedEvalSet);
  }

  private async saveEvalSet(
    appName: string,
    evalSetId: string,
    evalSet: EvalSet,
  ): Promise<void> {
    const filePath = this.getEvalSetFilePath(appName, evalSetId);
    await fsPromises.mkdir(path.dirname(filePath), {recursive: true});
    await fsPromises.writeFile(
      filePath,
      JSON.stringify(evalSet, null, 2),
      'utf-8',
    );
  }
}
