/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Type} from '@google/genai';
import * as path from 'node:path';
import {Context} from '../../agents/context.js';
import {isLlmAgent} from '../../agents/llm_agent.js';
import {
  CodeExecutionLanguage,
  CodeExecutionResult,
  File,
} from '../../code_executors/code_execution_utils.js';
import {BaseEnvironment} from '../../environment/base_environment.js';
import {getScript, Skill} from '../../skills/skill.js';
import {
  asRecord,
  formatError,
  isFileNotFoundError,
} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';
import {
  getMimeTypeAndEncoding,
  getScriptLanguageByExtension,
  SUPPORTED_SCRIPT_EXTENSIONS,
} from '../../utils/file_extension_utils.js';
import {materializeFiles} from '../../utils/file_utils.js';
import {logger} from '../../utils/logger.js';
import {RunAsyncToolRequest} from '../base_tool.js';
import {SkillErrorCode} from './skill_error_codes.js';
import {detectSkillToolError} from './skill_error_detection.js';
import {
  countInvocationFailure,
  SCRIPT_NOT_FOUND_COUNTER_PREFIX,
} from './skill_failure_counter.js';
import {SkillTool} from './skill_tool.js';
import {RUN_SKILL_SCRIPT_TOOL_NAME} from './skill_tool_names.js';
import {SkillToolset} from './skill_toolset.js';

/** Characters of a failure message reported before it is truncated. */
const MAX_ERROR_MESSAGE_LENGTH = 200;

/** Resource bytes a skill may carry into an executor before it is flagged. */
const MAX_SKILL_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Message returned while the call waits for a client to confirm the command.
 * Matches the message `run_skill_inline_script` returns for its own gate.
 */
const REQUIRE_CONFIRMATION_MESSAGE =
  'This tool call needs external confirmation before completion.';

/** The failure envelope `run_skill_script` returns instead of throwing. */
interface SkillScriptError {
  error: string;
  error_code: SkillErrorCode;
}

/** Builds a failure envelope, matching the key adk-python and the other
 * skill tools use. */
function skillScriptError(
  error: string,
  code: SkillErrorCode,
): SkillScriptError {
  return {error, error_code: code};
}

/** The parameters `run_skill_script` declares on both execution paths. */
const COMMON_SCRIPT_PARAMETERS = {
  skill_name: {
    type: Type.STRING,
    description: 'The name of the skill.',
  },
  script_path: {
    type: Type.STRING,
    description: "The relative path to the script (e.g., 'scripts/setup.js').",
  },
};

/** The parameters the model builds an argument list from, code-executor only. */
const SCRIPT_ARGUMENT_PARAMETERS = {
  args: {
    anyOf: [
      {type: Type.OBJECT},
      {type: Type.ARRAY, items: {type: Type.STRING}},
    ],
    description:
      'Optional arguments to pass to the script as key-value pairs' +
      ' (long options) or as a list of strings. If specified as a' +
      ' list, it is treated as the complete list of arguments, and' +
      " 'short_options' and 'positional_args' must not be provided.",
  },
  short_options: {
    type: Type.OBJECT,
    description:
      'Optional short options (single hyphen) to pass to the script' +
      " as key-value pairs. Must not be provided if 'args' is a list.",
  },
  positional_args: {
    type: Type.ARRAY,
    items: {type: Type.STRING},
    description:
      'Optional positional arguments to pass to the script. Must not' +
      " be provided if 'args' is a list.",
  },
};

@experimental
export class RunSkillScriptTool extends SkillTool {
  static readonly TOOL_NAME = RUN_SKILL_SCRIPT_TOOL_NAME;

  constructor(toolset: SkillToolset) {
    super(toolset, {
      name: toolset.toolName(RunSkillScriptTool.TOOL_NAME),
      description: "Executes a script from a skill's scripts/ directory.",
    });
  }

  /**
   * Whether this call is gated on human approval.
   *
   * Only the environment path is, because only it runs a command the model
   * wrote. The resume path asks this again a turn later, and refuses an
   * approval for a tool that answers "no", so the gate and this answer have to
   * agree.
   */
  override async checkRequireConfirmation(): Promise<boolean> {
    return this.toolset.environment !== undefined;
  }

  override _getDeclaration(): FunctionDeclaration {
    // The environment path takes a whole command line, so it offers none of
    // the argument-building parameters: the model composes the command itself.
    const variableParameters = this.toolset.environment
      ? {
          command: {
            type: Type.STRING,
            description: 'The command to execute in the environment.',
          },
        }
      : SCRIPT_ARGUMENT_PARAMETERS;

    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: Type.OBJECT,
        properties: {...COMMON_SCRIPT_PARAMETERS, ...variableParameters},
        required: this.toolset.environment
          ? ['skill_name', 'script_path', 'command']
          : ['skill_name', 'script_path'],
      },
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const skillName = args['skill_name'] as string;
    const scriptPath = args['script_path'] as string;

    if (!skillName) {
      return skillScriptError(
        'Skill name is required.',
        SkillErrorCode.MISSING_SKILL_NAME,
      );
    }
    if (!scriptPath) {
      return skillScriptError(
        'Script path is required.',
        SkillErrorCode.MISSING_SCRIPT_PATH,
      );
    }

    const command = typeof args['command'] === 'string' ? args['command'] : '';
    if (this.toolset.environment && !command) {
      return skillScriptError(
        "Argument 'command' is required and must be a string.",
        SkillErrorCode.INVALID_ARGUMENTS,
      );
    }

    let scriptArgv: string[] = [];
    if (!this.toolset.environment) {
      const argumentErrors = validateScriptArguments(args);
      if (argumentErrors.length > 0) {
        return skillScriptError(
          argumentErrors.join('\n'),
          SkillErrorCode.INVALID_ARGUMENTS,
        );
      }
      scriptArgv = buildScriptArgv(args);
    }

    let skill;
    try {
      skill = await this.toolset.getOrFetchSkill(
        skillName,
        toolContext.invocationId,
      );
    } catch (e: unknown) {
      return skillScriptError(
        `Failed to fetch skill '${skillName}' from registry: ${(e as Error).message || e}`,
        SkillErrorCode.REGISTRY_ERROR,
      );
    }

    if (!skill) {
      return skillScriptError(
        `Skill '${skillName}' not found.`,
        SkillErrorCode.SKILL_NOT_FOUND,
      );
    }

    const relScriptPath = scriptPath.startsWith('scripts/')
      ? scriptPath.substring('scripts/'.length)
      : scriptPath;
    const script =
      getScript(skill.resources, relScriptPath) ??
      getScript(skill.resources, scriptPath);

    if (!script) {
      // Counts every miss in the invocation, not misses of this path, so the
      // guard still fires when the model invents a fresh path each retry.
      const failCount = countInvocationFailure(
        toolContext,
        SCRIPT_NOT_FOUND_COUNTER_PREFIX,
      );
      if (failCount > 1) {
        return skillScriptError(
          `Script '${scriptPath}' not found in skill '${skillName}'.` +
            ` This is script lookup failure #${failCount} this invocation.` +
            ' Do not retry any script path — report the error to the user and' +
            ' stop.',
          SkillErrorCode.SCRIPT_NOT_FOUND_FATAL,
        );
      }
      return skillScriptError(
        `Script '${scriptPath}' not found in skill '${skillName}'.`,
        SkillErrorCode.SCRIPT_NOT_FOUND,
      );
    }

    const environment = this.toolset.environment;
    if (environment) {
      const gate = enforceCommandConfirmation(toolContext, command, skillName);
      if (gate) {
        return gate;
      }
      try {
        // The command may be the first thing to touch the environment, and
        // `skillsFolderIn` reads a working directory that only exists once it
        // is up.
        await this.toolset.ensureEnvironmentInitialized();
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
        return skillScriptError(
          `Failed to execute script '${scriptPath}' in environment:\n${describeCause(e)}`,
          SkillErrorCode.EXECUTION_ERROR,
        );
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
      return skillScriptError(
        'No code executor configured.',
        SkillErrorCode.NO_CODE_EXECUTOR,
      );
    }

    const language = getScriptLanguageByExtension(path.extname(scriptPath));
    if (language === CodeExecutionLanguage.UNSPECIFIED) {
      return skillScriptError(
        `Unsupported script type ${describeExtension(scriptPath)}. Supported types: ${SUPPORTED_SCRIPT_EXTENSIONS.join(', ')}`,
        SkillErrorCode.UNSUPPORTED_SCRIPT_TYPE,
      );
    }

    try {
      const inputFiles = getSkillResourceFiles(skill);
      warnOnOversizedPayload(skillName, inputFiles);
      const result = await codeExecutor.executeCode({
        invocationContext: toolContext.invocationContext,
        codeExecutionInput: {
          code: buildWrapperCode(scriptPath, language),
          inputFiles,
          language,
          args: scriptArgv,
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

      return {
        ...result,
        skill_name: skillName,
        script_path: scriptPath,
        status: deriveScriptStatus(result),
        outputDirectory: outputDir,
      };
    } catch (e: unknown) {
      return skillScriptError(
        `Failed to execute script '${scriptPath}': ${(e as Error).message}`,
        SkillErrorCode.EXECUTION_ERROR,
      );
    }
  }

  override detectErrorInResponse(response: unknown): string | undefined {
    const errorType = detectSkillToolError(response);
    if (errorType) {
      return errorType;
    }
    return asRecord(response)?.['status'] === 'error'
      ? SkillErrorCode.SKILL_SCRIPT_EXECUTION_ERROR
      : undefined;
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
      // `exit` inside the called script ends that script and returns here, so
      // the wrapper has to hand the status on or the caller reads a failure as
      // a clean run.
      return `& .\\${scriptPath.replace(/\//g, '\\\\')} $args\nexit $LASTEXITCODE`;
    case CodeExecutionLanguage.WINDOWS_CMD:
      return `call .\\${scriptPath.replace(/\//g, '\\\\')} %*`;
    default:
      throw new Error(`Unsupported wrapper language: ${language}`);
  }
}

export function getSkillResourceFiles(skill: Skill): File[] {
  const {references = {}, assets = {}, scripts = {}} = skill.resources ?? {};
  return [
    ...Object.entries(references).map(([name, content]) =>
      toResourceFile(`references/${name}`, content),
    ),
    ...Object.entries(assets).map(([name, content]) =>
      toResourceFile(`assets/${name}`, content),
    ),
    ...Object.entries(scripts).map(([name, script]) =>
      toResourceFile(`scripts/${name}`, script.src),
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

/**
 * Holds a model-authored command until a client confirms it.
 *
 * The environment runs the command as a shell command, and `LocalEnvironment`
 * runs it on the host. A prompt injection that reaches the model therefore
 * reaches the host shell, so the call pauses for approval the same way
 * `run_skill_inline_script` does. Returns `undefined` once the call is
 * confirmed, and the caller then executes the command.
 */
function enforceCommandConfirmation(
  toolContext: Context,
  command: string,
  skillName: string,
): {partial: string} | SkillScriptError | undefined {
  const confirmation = toolContext.toolConfirmation;

  if (!confirmation) {
    toolContext.requestConfirmation({
      hint:
        'Confirmation is required before running a skill script command in ' +
        `the environment. The agent requested to run this command for skill ` +
        `'${skillName}'. Only approve if you trust it:\n\n${command}`,
      payload: {skillName, command},
    });
    return {partial: REQUIRE_CONFIRMATION_MESSAGE};
  }

  if (!confirmation.confirmed) {
    return skillScriptError(
      'Skill script command was not confirmed and was rejected.',
      SkillErrorCode.CONFIRMATION_REJECTED,
    );
  }

  return undefined;
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
  // Every path is resolved before the first write, so a traversing name late
  // in the skill cannot leave a half-materialized directory behind.
  const writes: Array<[string, string | Buffer]> = [
    ...toWrites(skillDir, 'references', resources.references),
    ...toWrites(skillDir, 'assets', resources.assets),
    ...Object.entries(resources.scripts ?? {}).map(
      ([name, script]): [string, string | Buffer] => [
        resolveInSkillDir(skillDir, `scripts/${name}`),
        script.src,
      ],
    ),
  ];
  await Promise.all(
    writes.map(([target, body]) => env.writeFile(target, body)),
  );
}

/** Pairs each entry of `contents` with its validated path under `skillDir`. */
function toWrites(
  skillDir: string,
  subdirectory: string,
  contents: Record<string, string | Buffer> | undefined,
): Array<[string, string | Buffer]> {
  return Object.entries(contents ?? {}).map(([name, content]) => [
    resolveInSkillDir(skillDir, `${subdirectory}/${name}`),
    content,
  ]);
}

/**
 * Joins a resource path onto `skillDir`, refusing one that leaves that
 * directory.
 *
 * Resource names arrive with the skill from a registry, so a name such as
 * `../../.ssh/authorized_keys` would otherwise let a skill write anywhere the
 * environment can reach. This is a lexical check: it stops a traversing name,
 * and it does not survive a symlink the environment already contains.
 *
 * `resourcePath` is relative to `skillDir`, and only it is normalized.
 * `skillDir` is passed through untouched, because an environment reports its
 * working directory in its own form: resolving a drive-letter path through
 * POSIX rules would graft the host's current directory onto the front of it.
 */
function resolveInSkillDir(skillDir: string, resourcePath: string): string {
  // A backslash is folded into a separator as well: a remote sandbox is POSIX,
  // but a LocalEnvironment on Windows treats a backslash as one.
  const target = path.posix.normalize(resourcePath.replace(/\\/g, '/'));
  if (target === '..' || target.startsWith('../')) {
    throw new Error(
      `Path traversal detected: '${resourcePath}' resolves outside of ${skillDir}`,
    );
  }
  return `${skillDir}/${target}`;
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

/** Names the JSON type of `value` the way the argument messages report it. */
function describeArgumentType(value: unknown): string {
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * Checks the script argument surface, returning one message per problem.
 *
 * This only reports; the caller decides that a non-empty result is an error.
 */
function validateScriptArguments(args: Record<string, unknown>): string[] {
  const scriptArgs = args['args'];
  const shortOptions = args['short_options'];
  const positionalArgs = args['positional_args'];
  const errors: string[] = [];

  if (
    scriptArgs !== undefined &&
    !Array.isArray(scriptArgs) &&
    !isPlainRecord(scriptArgs)
  ) {
    errors.push(
      "'args' must be a JSON object (dict) or a list of strings, got" +
        ` ${describeArgumentType(scriptArgs)}.`,
    );
  }
  if (shortOptions !== undefined && !isPlainRecord(shortOptions)) {
    errors.push(
      "'short_options' must be a JSON object (dict), got" +
        ` ${describeArgumentType(shortOptions)}.`,
    );
  }
  if (positionalArgs !== undefined && !Array.isArray(positionalArgs)) {
    errors.push(
      "'positional_args' must be a list of strings, got" +
        ` ${describeArgumentType(positionalArgs)}.`,
    );
  }
  if (
    Array.isArray(scriptArgs) &&
    (isNonEmpty(shortOptions) || isNonEmpty(positionalArgs))
  ) {
    errors.push(
      "Cannot specify 'short_options' or 'positional_args' when 'args' is a" +
        ' list.',
    );
  }

  return errors;
}

/**
 * Assembles the argument vector handed to the executor. A list `args` is the
 * complete vector; otherwise long options, then short options, then the
 * positional arguments behind a `--` separator.
 *
 * Call only after {@link validateScriptArguments} reports no problem.
 */
function buildScriptArgv(args: Record<string, unknown>): string[] {
  const scriptArgs = args['args'];
  if (Array.isArray(scriptArgs)) {
    return scriptArgs.map(String);
  }

  const argv: string[] = [];
  if (isPlainRecord(scriptArgs)) {
    for (const [key, value] of Object.entries(scriptArgs)) {
      argv.push(`--${key}`, String(value));
    }
  }
  const shortOptions = args['short_options'];
  if (isPlainRecord(shortOptions)) {
    for (const [key, value] of Object.entries(shortOptions)) {
      argv.push(`-${key}`, String(value));
    }
  }
  const positionalArgs = args['positional_args'];
  if (Array.isArray(positionalArgs) && positionalArgs.length > 0) {
    argv.push('--', ...positionalArgs.map(String));
  }
  return argv;
}

/** Whether `value` is a JSON object rather than an array or a scalar. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is a non-empty array or a non-empty object. */
function isNonEmpty(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return isPlainRecord(value) && Object.keys(value).length > 0;
}

/** Renders the extension of `scriptPath` for the unsupported-type message. */
function describeExtension(scriptPath: string): string {
  const extension = path.extname(scriptPath);
  return extension ? `'${extension}'` : '(no extension)';
}

/**
 * Classifies a completed run as `success`, `warning` or `error`.
 *
 * A reported non-zero status is an error. With no status reported, the streams
 * decide: output on stderr alone is an error, and stderr alongside stdout is a
 * warning. That is the branch adk-python falls back to when its executor
 * reports no status.
 */
function deriveScriptStatus(
  result: CodeExecutionResult,
): 'success' | 'warning' | 'error' {
  // `0`, `null` and `undefined` are all falsy, so a run that reported success
  // and one that reported nothing are both classified from the streams.
  if (result.exitCode) {
    return 'error';
  }
  if (!result.stderr) {
    return 'success';
  }
  return result.stdout ? 'warning' : 'error';
}

/** Warns when a skill's resources exceed the size an executor should carry. */
function warnOnOversizedPayload(skillName: string, files: File[]): void {
  // Measured through each file's own encoding: a base64 string is a third
  // larger than the bytes it carries, so counting its characters would report
  // a binary skill as oversized well before it is.
  const totalBytes = files.reduce(
    (total, file) =>
      total + Buffer.byteLength(file.content, file.contentEncoding ?? 'utf-8'),
    0,
  );
  if (totalBytes > MAX_SKILL_PAYLOAD_BYTES) {
    logger.warn(
      `Skill '${skillName}' resources total ${totalBytes} bytes, exceeding the recommended limit of ${MAX_SKILL_PAYLOAD_BYTES} bytes.`,
    );
  }
}
