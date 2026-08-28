/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Factory for the Agent Builder Assistant.
 *
 * Ported from `cli/built_in_agents/adk_agent_builder_assistant.py` in
 * adk-python.
 */

import {
  BaseLlm,
  InstructionProvider,
  isBaseLlm,
  LlmAgent,
  ReadonlyContext,
} from '@google/adk';
import * as path from 'node:path';

import {agentBuilderInstruction} from './instruction.js';
import {deleteFilesTool} from './tools/delete_files.js';
import {readFilesTool} from './tools/read_files.js';
import {writeFilesTool} from './tools/write_files.js';
import {rootDirectoryFromContext} from './utils/resolve_root_directory.js';

/** Model the assistant uses when the caller names none. */
const DEFAULT_MODEL = 'gemini-2.5-pro';

/** Folder name used when the project root resolves to a nameless path. */
const FALLBACK_PROJECT_FOLDER_NAME = 'project';

/** Cap on the assistant's reply, large enough to emit several files at once. */
const MAX_OUTPUT_TOKENS = 8192;

/** Options accepted by {@link createAgentBuilderAssistant}. */
export interface AgentBuilderAssistantOptions {
  /** Model backing the assistant. Defaults to `gemini-2.5-pro`. */
  model?: string | BaseLlm;
}

/**
 * Names the folder the chat session is bound to.
 *
 * @param context The invocation the instruction is built for.
 * @return The project folder name, or `project` when the root has none.
 */
function projectFolderName(context: ReadonlyContext): string {
  return (
    path.basename(path.resolve(rootDirectoryFromContext(context))) ||
    FALLBACK_PROJECT_FOLDER_NAME
  );
}

/**
 * Builds an assistant that designs an adk-js agent with the user, then writes
 * it into the project directory the chat session names.
 *
 * The session's `root_directory` state key binds the assistant to one project.
 * Every path its tools touch is resolved against that root and refused when it
 * lands outside.
 *
 * @param options The model backing the assistant.
 * @return The configured assistant.
 */
export function createAgentBuilderAssistant(
  options: AgentBuilderAssistantOptions = {},
): LlmAgent {
  const model = options.model ?? DEFAULT_MODEL;
  const defaultModel = isBaseLlm(model) ? model.model : model;

  const instruction: InstructionProvider = (context) =>
    agentBuilderInstruction({
      defaultModel,
      projectFolderName: projectFolderName(context),
    });

  return new LlmAgent({
    name: 'agent_builder_assistant',
    description: 'Intelligent assistant for building ADK multi-agent systems',
    model,
    instruction,
    tools: [readFilesTool, writeFilesTool, deleteFilesTool],
    generateContentConfig: {maxOutputTokens: MAX_OUTPUT_TOKENS},
  });
}
