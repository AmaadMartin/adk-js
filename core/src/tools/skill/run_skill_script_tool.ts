/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import * as path from 'node:path';
import {isLlmAgent} from '../../agents/llm_agent.js';
import {
  CodeExecutionLanguage,
  File,
} from '../../code_executors/code_execution_utils.js';
import {
  getAsset,
  getReference,
  getScript,
  listAssets,
  listReferences,
  listScripts,
  scriptToString,
  Skill,
} from '../../skills/skill.js';
import {experimental} from '../../utils/experimental.js';
import {
  getMimeTypeAndEncoding,
  getScriptLanguageByExtension,
} from '../../utils/file_extension_utils.js';
import {materializeFiles} from '../../utils/file_utils.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {SkillToolset} from './skill_toolset.js';

@experimental
export class RunSkillScriptTool extends BaseTool {
  constructor(private toolset: SkillToolset) {
    super({
      name: 'run_skill_script',
      description: "Executes a script from a skill's scripts/ directory.",
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {
          skill_name: {
            type: Type.STRING,
            description: 'The name of the skill.',
          },
          script_path: {
            type: Type.STRING,
            description:
              "The relative path to the script (e.g., 'scripts/setup.js').",
          },
          args: {
            type: Type.OBJECT,
            description:
              'Optional arguments to pass to the script as key-value pairs.',
          },
        },
        required: ['skill_name', 'script_path'],
      },
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const skillName = args['skill_name'] as string;
    const scriptPath = args['script_path'] as string;
    const scriptArgs =
      (args['args'] as Record<string, string | number | boolean>) || {};

    if (!skillName) {
      return {
        error: 'Skill name is required.',
        errorCode: 'MISSING_SKILL_NAME',
      };
    }
    if (!scriptPath) {
      return {
        error: 'Script path is required.',
        errorCode: 'MISSING_SCRIPT_PATH',
      };
    }

    let skill;
    try {
      skill = await this.toolset.getOrFetchSkill(
        skillName,
        toolContext.invocationId,
      );
    } catch (e: unknown) {
      return {
        error: `Failed to fetch skill '${skillName}' from registry: ${(e as Error).message || e}`,
        errorCode: 'REGISTRY_ERROR',
      };
    }

    if (!skill) {
      return {
        error: `Skill '${skillName}' not found.`,
        errorCode: 'SKILL_NOT_FOUND',
      };
    }

    const relScriptPath = scriptPath.startsWith('scripts/')
      ? scriptPath.substring('scripts/'.length)
      : scriptPath;
    const script =
      getScript(skill.resources, relScriptPath) ??
      getScript(skill.resources, scriptPath);

    if (!script) {
      return {
        error: `Script '${scriptPath}' not found in skill '${skillName}'.`,
        errorCode: 'SCRIPT_NOT_FOUND',
      };
    }

    let codeExecutor = this.toolset.codeExecutor;
    if (!codeExecutor) {
      const agent = toolContext.invocationContext.agent;
      if (isLlmAgent(agent)) {
        codeExecutor = agent.codeExecutor;
      }
    }

    if (!codeExecutor) {
      return {
        error: 'No code executor configured.',
        errorCode: 'NO_CODE_EXECUTOR',
      };
    }

    try {
      const language = getScriptLanguageByExtension(path.extname(scriptPath));
      const result = await codeExecutor.executeCode({
        invocationContext: toolContext.invocationContext,
        codeExecutionInput: {
          code: buildWrapperCode(scriptPath, language),
          inputFiles: getSkillResourceFiles(skill),
          language,
          args: scriptArgs,
        },
      });

      // Output file names are chosen by the executed script, so they are
      // materialized into a dedicated output directory rather than being
      // resolved against the host application's working directory.
      const outputDir = await this.toolset.getScriptOutputDir();
      // Final filename could be different if there was a collision, so update the result.
      result.outputFiles = await materializeFiles(
        result.outputFiles,
        outputDir,
      );

      return {...result, outputDirectory: outputDir};
    } catch (e: unknown) {
      return {
        error: `Failed to execute script '${scriptPath}': ${(e as Error).message}`,
        errorCode: 'EXECUTION_ERROR',
      };
    }
  }
}

function buildWrapperCode(
  scriptPath: string,
  language: CodeExecutionLanguage,
): string {
  switch (language) {
    case CodeExecutionLanguage.JAVASCRIPT:
      return `require('./${scriptPath}');`;
    case CodeExecutionLanguage.TYPESCRIPT:
      return `require('ts-node/register');\nrequire('./${scriptPath}');`;
    case CodeExecutionLanguage.PYTHON:
      return `import runpy\nrunpy.run_path('./${scriptPath}', run_name='__main__')`;
    case CodeExecutionLanguage.SHELL:
      return `source ./${scriptPath} "$@"`;
    case CodeExecutionLanguage.POWERSHELL:
      return `& .\\${scriptPath.replace(/\//g, '\\\\')} $args`;
    case CodeExecutionLanguage.WINDOWS_CMD:
      return `call .\\${scriptPath.replace(/\//g, '\\\\')} %*`;
    default:
      throw new Error(`Unsupported wrapper language: ${language}`);
  }
}

export function getSkillResourceFiles(skill: Skill): File[] {
  const {resources} = skill;
  // The keys come from the same maps the getters read, so no getter can miss.
  return [
    ...listReferences(resources).map((name) =>
      toResourceFile(`references/${name}`, getReference(resources, name)!),
    ),
    ...listAssets(resources).map((name) =>
      toResourceFile(`assets/${name}`, getAsset(resources, name)!),
    ),
    ...listScripts(resources).map((name) =>
      toResourceFile(
        `scripts/${name}`,
        scriptToString(getScript(resources, name)!),
      ),
    ),
  ];
}

function toResourceFile(name: string, content: string | Buffer): File {
  const {encoding, mimeType} = getMimeTypeAndEncoding(
    path.extname(name).toLowerCase(),
  );
  return {
    name,
    content: Buffer.from(content).toString(encoding),
    contentEncoding: encoding,
    mimeType,
  };
}
