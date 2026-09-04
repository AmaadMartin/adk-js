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
import {BaseEnvironment} from '../../environment/base_environment.js';
import {Script, Skill} from '../../skills/skill.js';
import {formatError, isFileNotFoundError} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';
import {
  getMimeTypeAndEncoding,
  getScriptLanguageByExtension,
} from '../../utils/file_extension_utils.js';
import {materializeFiles} from '../../utils/file_utils.js';
import {logger} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {SkillErrorCode} from './skill_error_codes.js';
import {RUN_SKILL_SCRIPT_TOOL_NAME} from './skill_tool_names.js';
import {SkillToolset} from './skill_toolset.js';

/** Characters of a failure message reported before it is truncated. */
const MAX_ERROR_MESSAGE_LENGTH = 200;

@experimental
export class RunSkillScriptTool extends BaseTool {
  static readonly TOOL_NAME = RUN_SKILL_SCRIPT_TOOL_NAME;

  constructor(private toolset: SkillToolset) {
    super({
      name: toolset.toolName(RunSkillScriptTool.TOOL_NAME),
      description: "Executes a script from a skill's scripts/ directory.",
    });
  }

  override _getDeclaration(): FunctionDeclaration {
    if (this.toolset.environment) {
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
            command: {
              type: Type.STRING,
              description: 'The command to execute in the environment.',
            },
          },
          required: ['skill_name', 'script_path', 'command'],
        },
      };
    }

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
        errorCode: SkillErrorCode.MISSING_SKILL_NAME,
      };
    }
    if (!scriptPath) {
      return {
        error: 'Script path is required.',
        errorCode: SkillErrorCode.MISSING_SCRIPT_PATH,
      };
    }

    const command = typeof args['command'] === 'string' ? args['command'] : '';
    if (this.toolset.environment && !command) {
      return {
        error: "Argument 'command' is required and must be a string.",
        errorCode: SkillErrorCode.INVALID_ARGUMENTS,
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
        errorCode: SkillErrorCode.REGISTRY_ERROR,
      };
    }

    if (!skill) {
      return {
        error: `Skill '${skillName}' not found.`,
        errorCode: SkillErrorCode.SKILL_NOT_FOUND,
      };
    }

    const relScriptPath = scriptPath.startsWith('scripts/')
      ? scriptPath.substring('scripts/'.length)
      : scriptPath;
    let script = skill.resources?.scripts?.[relScriptPath];
    if (!script) {
      script = skill.resources?.scripts?.[scriptPath];
    }

    if (!script) {
      return {
        error: `Script '${scriptPath}' not found in skill '${skillName}'.`,
        errorCode: SkillErrorCode.SCRIPT_NOT_FOUND,
      };
    }

    const environment = this.toolset.environment;
    if (environment) {
      try {
        await ensureSkillMaterializedInEnv(
          this.toolset.skillsFolderIn(environment),
          skill,
          scriptPath,
          environment,
        );
        const result = await environment.execute(
          command,
          this.toolset.scriptTimeoutSeconds,
        );
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exitCode,
          timed_out: result.timedOut,
        };
      } catch (e: unknown) {
        return {
          error: `Failed to execute script '${scriptPath}' in environment:\n${describeCause(e)}`,
          errorCode: SkillErrorCode.EXECUTION_ERROR,
        };
      }
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
        errorCode: SkillErrorCode.NO_CODE_EXECUTOR,
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
        errorCode: SkillErrorCode.EXECUTION_ERROR,
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
  const files: File[] = [];

  for (const resourceType of ['references', 'assets', 'scripts']) {
    const resources =
      skill.resources?.[resourceType as keyof Skill['resources']] ?? {};

    for (const resourceName of Object.keys(resources)) {
      const content =
        resources[resourceName as keyof typeof resources] ?? undefined;

      if (content === undefined) {
        continue;
      }

      let fileContent: string | Buffer | undefined = undefined;
      if (typeof content === 'string' || Buffer.isBuffer(content)) {
        fileContent = content;
      } else if (
        typeof content === 'object' &&
        content !== null &&
        'src' in content &&
        typeof (content as Script).src === 'string'
      ) {
        fileContent = (content as Script).src;
      }

      if (fileContent === undefined) {
        continue;
      }

      const ext = path.extname(resourceName).toLowerCase();
      const {encoding, mimeType} = getMimeTypeAndEncoding(ext);
      files.push({
        name: `${resourceType}/${resourceName}`,
        content: Buffer.from(fileContent).toString(encoding),
        contentEncoding: encoding,
        mimeType,
      });
    }
  }

  return files;
}

/**
 * Writes the skill's resources into `env` the first time one of its scripts is
 * run, so a command the model supplies can reach them on the filesystem.
 */
async function ensureSkillMaterializedInEnv(
  skillsFolder: string,
  skill: Skill,
  scriptPath: string,
  env: BaseEnvironment,
): Promise<void> {
  const skillDir = `${skillsFolder}/${skill.frontmatter.name}`;
  const relScriptPath = scriptPath.startsWith('scripts/')
    ? scriptPath
    : `scripts/${scriptPath}`;

  try {
    await env.readFile(`${skillDir}/${relScriptPath}`);
    return;
  } catch (e: unknown) {
    // Only a missing file means "not materialized yet". Anything else — a
    // permission failure, a transport error from a remote sandbox — must reach
    // the caller rather than trigger a pointless rewrite.
    if (!isFileNotFoundError(e)) {
      throw e;
    }
  }

  logger.debug(
    `Materializing skill resources for ${skill.frontmatter.name} in environment`,
  );
  const resources = skill.resources ?? {};
  const writes = [
    ...Object.entries(resources.references ?? {}).map(([name, content]) =>
      env.writeFile(`${skillDir}/references/${name}`, content),
    ),
    ...Object.entries(resources.assets ?? {}).map(([name, content]) =>
      env.writeFile(`${skillDir}/assets/${name}`, content),
    ),
    ...Object.entries(resources.scripts ?? {}).map(([name, script]) =>
      env.writeFile(`${skillDir}/scripts/${name}`, script.src),
    ),
  ];
  await Promise.all(writes);
}

/** Renders a thrown value as `<Name>: <message>`, truncating a long message. */
function describeCause(err: unknown): string {
  const name = err instanceof Error ? err.name : 'Error';
  const message = formatError(err);
  return `${name}: ${
    message.length > MAX_ERROR_MESSAGE_LENGTH
      ? `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`
      : message
  }`;
}
