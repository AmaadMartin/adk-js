/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import {NotFoundError} from '../errors/not_found_error.js';
import {nowSeconds, randomUUID} from '../utils/env_aware_utils.js';
import {toCamelCase, toSnakeCase} from '../utils/object_notation_utils.js';
import {EvalCase} from './eval_case.js';
import {EvalSet, EvalSetSchema} from './eval_set.js';
import {EvalSetsManager} from './eval_sets_manager.js';
import {
  addEvalCaseToEvalSet,
  deleteEvalCaseFromEvalSet,
  getEvalCaseFromEvalSet,
  getEvalSetFromAppAndId,
  updateEvalCaseInEvalSet,
} from './eval_sets_manager_utils.js';
import {validatePathSegment} from './path_validation.js';

/**
 * File extension used for locally-stored eval sets.
 */
export const EVAL_SET_FILE_EXTENSION = '.evalset.json';

/**
 * Regex that a valid eval set id must fully match (parity with adk-python).
 */
const VALID_ID_PATTERN = /^[a-zA-Z0-9_]+$/;

/**
 * Keys preserved (not key-rewritten) when writing an EvalSet to disk, so opaque
 * sub-objects (tool call args/responses, session state) round-trip verbatim.
 *
 * simplicity: ceiling=minimum. Covers the {@link IntermediateData} shape of
 * `intermediateData`; extend if a round-trip test surfaces a mangled field.
 */
const EVAL_SET_PRESERVE_KEYS_CAMEL_CASE = [
  'evalCases.sessionInput.state',
  'evalCases.finalSessionState',
  'evalCases.conversation.userContent.parts.functionCall.args',
  'evalCases.conversation.userContent.parts.functionResponse.response',
  'evalCases.conversation.finalResponse.parts.functionCall.args',
  'evalCases.conversation.finalResponse.parts.functionResponse.response',
  'evalCases.conversation.intermediateData.toolUses.args',
  'evalCases.conversation.intermediateData.toolResponses.response',
];

/**
 * The snake_case counterparts of {@link EVAL_SET_PRESERVE_KEYS_CAMEL_CASE}, used
 * when reading an EvalSet from disk.
 */
const EVAL_SET_PRESERVE_KEYS_SNAKE_CASE = [
  'eval_cases.session_input.state',
  'eval_cases.final_session_state',
  'eval_cases.conversation.user_content.parts.function_call.args',
  'eval_cases.conversation.user_content.parts.function_response.response',
  'eval_cases.conversation.final_response.parts.function_call.args',
  'eval_cases.conversation.final_response.parts.function_response.response',
  'eval_cases.conversation.intermediate_data.tool_uses.args',
  'eval_cases.conversation.intermediate_data.tool_responses.response',
];

/** A tool call in the legacy (pre-schema) eval set JSON format. */
export interface LegacyToolUse {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/** An intermediate agent response in the legacy eval set JSON format. */
export interface LegacyIntermediateResponse {
  author: string;
  text: string;
}

/** A single invocation in the legacy eval set JSON format. */
export interface LegacyInvocation {
  query: string;
  reference?: string;
  expected_tool_use?: LegacyToolUse[];
  expected_intermediate_agent_responses?: LegacyIntermediateResponse[];
}

/** The initial session in the legacy eval set JSON format. */
export interface LegacyInitialSession {
  app_name?: string;
  user_id?: string;
  state?: Record<string, unknown>;
}

/** An eval case in the legacy eval set JSON format. */
export interface LegacyEvalCase {
  name: string;
  data: LegacyInvocation[];
  initial_session?: LegacyInitialSession;
}

function isFileNotFoundError(error: unknown): boolean {
  return (error as {code?: string})?.code === 'ENOENT';
}

function convertInvocationToSchema(
  invocation: LegacyInvocation,
): Record<string, unknown> {
  const query = invocation.query;
  const reference = invocation.reference ?? '';
  const toolUses = (invocation.expected_tool_use ?? []).map((toolUse) => ({
    name: toolUse.tool_name,
    args: toolUse.tool_input,
  }));
  const intermediateResponses = (
    invocation.expected_intermediate_agent_responses ?? []
  ).map((response) => [response.author, [{text: response.text}]]);

  return {
    invocationId: randomUUID(),
    userContent: {parts: [{text: query}], role: 'user'},
    finalResponse: {parts: [{text: reference}], role: 'model'},
    intermediateData: {
      toolUses,
      toolResponses: [],
      intermediateResponses,
    },
    creationTimestamp: nowSeconds(),
  };
}

/**
 * Converts an eval set from the legacy JSON array format to an {@link EvalSet}.
 */
export function convertEvalSetToSchema(
  evalSetId: string,
  evalSetInJsonFormat: LegacyEvalCase[],
): EvalSet {
  const evalCases = evalSetInJsonFormat.map((oldEvalCase) => {
    const conversation = oldEvalCase.data.map(convertInvocationToSchema);

    let sessionInput: Record<string, unknown> | undefined;
    const initialSession = oldEvalCase.initial_session;
    if (initialSession && Object.keys(initialSession).length > 0) {
      sessionInput = {
        appName: initialSession.app_name ?? '',
        userId: initialSession.user_id ?? '',
        state: initialSession.state ?? {},
      };
    }

    return {
      evalId: oldEvalCase.name,
      conversation,
      sessionInput,
      creationTimestamp: nowSeconds(),
    };
  });

  return EvalSetSchema.parse({
    evalSetId,
    name: evalSetId,
    creationTimestamp: nowSeconds(),
    evalCases,
  });
}

/**
 * Reads an {@link EvalSet} from the given file.
 *
 * A top-level JSON array is treated as the legacy format and converted via
 * {@link convertEvalSetToSchema}; a JSON object is validated as the current
 * schema.
 *
 * @throws Propagates the underlying `ENOENT` error if the file does not exist.
 * @throws {SyntaxError} If the file does not contain valid JSON.
 * @throws {ZodError} If the JSON object is not a valid EvalSet. (In adk-python
 *     this path is a Pydantic validation error; adk-js validates with zod.)
 */
export async function loadEvalSetFromFile(
  evalSetFilePath: string,
  evalSetId: string,
): Promise<EvalSet> {
  const content = await fs.readFile(evalSetFilePath, 'utf-8');
  const parsed: unknown = JSON.parse(content);
  if (Array.isArray(parsed)) {
    return convertEvalSetToSchema(evalSetId, parsed as LegacyEvalCase[]);
  }
  return EvalSetSchema.parse(
    toCamelCase(parsed, EVAL_SET_PRESERVE_KEYS_SNAKE_CASE),
  );
}

/**
 * An {@link EvalSetsManager} that stores eval sets locally on disk.
 */
export class LocalEvalSetsManager extends EvalSetsManager {
  constructor(private readonly agentsDir: string) {
    super();
  }

  async getEvalSet(
    appName: string,
    evalSetId: string,
  ): Promise<EvalSet | undefined> {
    const evalSetFilePath = this.getEvalSetFilePath(appName, evalSetId);
    try {
      return await loadEvalSetFromFile(evalSetFilePath, evalSetId);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async createEvalSet(appName: string, evalSetId: string): Promise<EvalSet> {
    this.validateId('Eval Set ID', evalSetId);
    const newEvalSetPath = this.getEvalSetFilePath(appName, evalSetId);

    if (await this.pathExists(newEvalSetPath)) {
      throw new Error(
        `EvalSet ${evalSetId} already exists for app ${appName}.`,
      );
    }

    const newEvalSet: EvalSet = {
      evalSetId,
      name: evalSetId,
      evalCases: [],
      creationTimestamp: nowSeconds(),
    };
    await this.writeEvalSetToPath(newEvalSetPath, newEvalSet);
    return newEvalSet;
  }

  async listEvalSets(appName: string): Promise<string[]> {
    validatePathSegment(appName, 'app_name');
    const evalSetDir = path.join(this.agentsDir, appName);
    let files: string[];
    try {
      files = await fs.readdir(evalSetDir);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        throw new NotFoundError(
          `Eval directory for app \`${appName}\` not found.`,
        );
      }
      throw error;
    }
    return files
      .filter((file) => file.endsWith(EVAL_SET_FILE_EXTENSION))
      .map((file) => file.slice(0, -EVAL_SET_FILE_EXTENSION.length))
      .sort();
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
    const evalSet = await getEvalSetFromAppAndId(this, appName, evalSetId);
    const updatedEvalSet = addEvalCaseToEvalSet(evalSet, evalCase);
    await this.saveEvalSet(appName, evalSetId, updatedEvalSet);
  }

  async updateEvalCase(
    appName: string,
    evalSetId: string,
    updatedEvalCase: EvalCase,
  ): Promise<void> {
    const evalSet = await getEvalSetFromAppAndId(this, appName, evalSetId);
    const updatedEvalSet = updateEvalCaseInEvalSet(evalSet, updatedEvalCase);
    await this.saveEvalSet(appName, evalSetId, updatedEvalSet);
  }

  async deleteEvalCase(
    appName: string,
    evalSetId: string,
    evalCaseId: string,
  ): Promise<void> {
    const evalSet = await getEvalSetFromAppAndId(this, appName, evalSetId);
    const updatedEvalSet = deleteEvalCaseFromEvalSet(evalSet, evalCaseId);
    await this.saveEvalSet(appName, evalSetId, updatedEvalSet);
  }

  private getEvalSetFilePath(appName: string, evalSetId: string): string {
    validatePathSegment(appName, 'app_name');
    validatePathSegment(evalSetId, 'eval_set_id');
    return path.join(
      this.agentsDir,
      appName,
      evalSetId + EVAL_SET_FILE_EXTENSION,
    );
  }

  private validateId(idName: string, idValue: string): void {
    if (!VALID_ID_PATTERN.test(idValue)) {
      throw new Error(
        `Invalid ${idName}. ${idName} should have the` +
          ` \`${VALID_ID_PATTERN.source}\` format`,
      );
    }
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async writeEvalSetToPath(
    evalSetPath: string,
    evalSet: EvalSet,
  ): Promise<void> {
    await fs.mkdir(path.dirname(evalSetPath), {recursive: true});
    await fs.writeFile(
      evalSetPath,
      JSON.stringify(
        toSnakeCase(evalSet, EVAL_SET_PRESERVE_KEYS_CAMEL_CASE),
        null,
        2,
      ),
      'utf-8',
    );
  }

  private async saveEvalSet(
    appName: string,
    evalSetId: string,
    evalSet: EvalSet,
  ): Promise<void> {
    const evalSetFilePath = this.getEvalSetFilePath(appName, evalSetId);
    await this.writeEvalSetToPath(evalSetFilePath, evalSet);
  }
}
