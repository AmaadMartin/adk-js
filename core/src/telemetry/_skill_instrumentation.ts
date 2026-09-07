/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill telemetry for the `execute_tool` span.
 *
 * A skill tool opens a record at the top of its `runAsync`, then fills the
 * record in as the call resolves. The record reaches the enclosing
 * `execute_tool` span through the OpenTelemetry context, and `callToolAsync`
 * stamps it onto the span once the tool call finishes. A tool that runs
 * outside a tool execution still gets a usable record; nothing is stamped.
 *
 * Attributes written, all experimental:
 *
 * | Attribute | Written for |
 * | --- | --- |
 * | `adk.experimental.skill.name` | every kind |
 * | `adk.experimental.skill.description` | a resolved skill load |
 * | `adk.experimental.skill.additional_tools` | a resolved skill load |
 * | `adk.experimental.skill.source.uri` | any resolved skill with a `uri` |
 * | `adk.experimental.skill.resource.path` | a resource load |
 * | `adk.experimental.skill.script.path` | a script execution |
 * | `adk.experimental.skill.script.exit_code` | a script that reported one |
 * | `error.type` | a script that exited non-zero |
 *
 * Nothing is written unless `ADK_EXPERIMENTAL_TELEMETRY` is set. Experimental
 * attributes carry no compatibility guarantee: any of them can be renamed,
 * restructured or removed in any release.
 *
 * Telemetry never fails a tool call. `dispatchSkillTelemetry` swallows and logs
 * anything that goes wrong while it writes to the span.
 *
 * Ported from the skill slice of
 * `src/google/adk/telemetry/_instrumentation.py` in `google/adk-python` at
 * `b0180620f4c2f4f4467a89c37a30f75bf849700b`.
 */

import {
  Attributes,
  context,
  createContextKey,
  Span,
  SpanStatusCode,
} from '@opentelemetry/api';

import {Skill} from '../skills/skill.js';
import {getBooleanEnvVar} from '../utils/env_aware_utils.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {
  ADK_EXPERIMENTAL_SKILL_ADDITIONAL_TOOLS,
  ADK_EXPERIMENTAL_SKILL_DESCRIPTION,
  ADK_EXPERIMENTAL_SKILL_NAME,
  ADK_EXPERIMENTAL_SKILL_RESOURCE_PATH,
  ADK_EXPERIMENTAL_SKILL_SCRIPT_EXIT_CODE,
  ADK_EXPERIMENTAL_SKILL_SCRIPT_PATH,
  ADK_EXPERIMENTAL_SKILL_SOURCE_URI,
} from './_adk_attributes.js';
import {MaybeHallucinated} from './_hallucination.js';

const ERROR_TYPE = 'error.type';

/** The `error.type` a script that exited non-zero reports. */
const SKILL_SCRIPT_EXECUTION_ERROR = 'SKILL_SCRIPT_EXECUTION_ERROR';

/** The skill frontmatter key listing the tools a skill also needs. */
const ADDITIONAL_TOOLS_METADATA_KEY = 'adk_additional_tools';

/** What every skill telemetry record carries. */
interface SkillTelemetryCommon {
  /** The name of the skill, as the model wrote it until something resolves it. */
  skillName: MaybeHallucinated<string>;
  /**
   * The skill the toolset resolved, or `undefined` when the load produced
   * none. Nothing about the skill is recorded in that case; the failure itself
   * is already reported as the span's `error.type`.
   */
  skill?: Skill;
}

/** What a `load_skill` call reports. */
export interface SkillLoadTelemetry extends SkillTelemetryCommon {
  readonly kind: 'load';
}

/** What a `load_skill_resource` call reports. */
export interface SkillResourceLoadTelemetry extends SkillTelemetryCommon {
  readonly kind: 'resourceLoad';
  /** The resource path, as the model wrote it until the resource resolves. */
  resourcePath: MaybeHallucinated<string>;
}

/** What a `run_skill_script` call reports. */
export interface SkillScriptExecutionTelemetry extends SkillTelemetryCommon {
  readonly kind: 'scriptExecution';
  /** The script path, as the model wrote it until the script resolves. */
  scriptPath: MaybeHallucinated<string>;
  /**
   * The status the script exited with. `undefined` or `null` means the script
   * never ran, or the executor cannot report one.
   */
  scriptExitCode?: number | null;
}

/** What one skill tool call reports about the skill it touched. */
export type SkillTelemetry =
  | SkillLoadTelemetry
  | SkillResourceLoadTelemetry
  | SkillScriptExecutionTelemetry;

const SKILL_TOOL_SCOPE = Symbol('adk.skillToolScope');

/** What one tool call reports back while its `execute_tool` span is open. */
export interface SkillToolScope {
  readonly [SKILL_TOOL_SCOPE]: true;
  skillTelemetry?: SkillTelemetry;
}

const SKILL_TOOL_SCOPE_KEY = createContextKey('adk.skill_tool_scope');

/** Creates the scope one `execute_tool` span collects skill telemetry into. */
export function createSkillToolScope(): SkillToolScope {
  return {[SKILL_TOOL_SCOPE]: true};
}

function isSkillToolScope(value: unknown): value is SkillToolScope {
  return (
    typeof value === 'object' && value !== null && SKILL_TOOL_SCOPE in value
  );
}

function activeSkillToolScope(): SkillToolScope | undefined {
  const value = context.active().getValue(SKILL_TOOL_SCOPE_KEY);
  return isSkillToolScope(value) ? value : undefined;
}

/**
 * Publishes `scope` on the OpenTelemetry context for the duration of `fn`.
 *
 * A skill tool running underneath reports back through the scope rather than
 * reaching for the ambient span, so skill attributes cannot land on an
 * unrelated span.
 */
export function withSkillToolScope<T>(
  scope: SkillToolScope,
  fn: () => Promise<T>,
): Promise<T> {
  return context.with(
    context.active().setValue(SKILL_TOOL_SCOPE_KEY, scope),
    fn,
  );
}

/**
 * Attaches skill telemetry to the enclosing tool execution.
 *
 * Outside a tool execution this is a no-op rather than an attribute silently
 * landing on whatever span happens to be current. A tool execution references
 * a single skill, so a second call within the same tool execution replaces the
 * first.
 */
export function attachSkillTelemetry(skillTelemetry: SkillTelemetry): void {
  const scope = activeSkillToolScope();
  if (scope === undefined) {
    logger.debug(
      'No tool execution is being recorded, skill telemetry will not be attached to current span.',
    );
    return;
  }
  if (scope.skillTelemetry !== undefined) {
    logger.warn(
      'Tool execution already has attached skill telemetry, overwriting.',
    );
  }
  scope.skillTelemetry = skillTelemetry;
}

/** Opens a skill load record and attaches it to the enclosing tool execution. */
export function trackSkillLoad(
  skillName: MaybeHallucinated<string>,
): SkillLoadTelemetry {
  const skillTelemetry: SkillLoadTelemetry = {kind: 'load', skillName};
  attachSkillTelemetry(skillTelemetry);
  return skillTelemetry;
}

/**
 * Opens a skill resource load record and attaches it to the enclosing tool
 * execution.
 */
export function trackSkillResourceLoad(
  skillName: MaybeHallucinated<string>,
  resourcePath: MaybeHallucinated<string>,
): SkillResourceLoadTelemetry {
  const skillTelemetry: SkillResourceLoadTelemetry = {
    kind: 'resourceLoad',
    skillName,
    resourcePath,
  };
  attachSkillTelemetry(skillTelemetry);
  return skillTelemetry;
}

/**
 * Opens a skill script execution record and attaches it to the enclosing tool
 * execution.
 */
export function trackSkillScriptExecution(
  skillName: MaybeHallucinated<string>,
  scriptPath: MaybeHallucinated<string>,
): SkillScriptExecutionTelemetry {
  const skillTelemetry: SkillScriptExecutionTelemetry = {
    kind: 'scriptExecution',
    skillName,
    scriptPath,
  };
  attachSkillTelemetry(skillTelemetry);
  return skillTelemetry;
}

/**
 * Reads the tools a resolved skill also needs.
 *
 * @returns The tool names, or `undefined` when the skill did not resolve or
 *     the frontmatter does not list a string array.
 */
export function additionalToolsOf(
  skillTelemetry: SkillLoadTelemetry,
): string[] | undefined {
  const value =
    skillTelemetry.skill?.frontmatter.metadata?.[ADDITIONAL_TOOLS_METADATA_KEY];
  if (
    !Array.isArray(value) ||
    !value.every((tool) => typeof tool === 'string')
  ) {
    return undefined;
  }
  return value;
}

/** Whether the run opted into experimental telemetry. */
function shouldEmitExperimentalTelemetry(): boolean {
  return getBooleanEnvVar('ADK_EXPERIMENTAL_TELEMETRY');
}

/**
 * Stamps what the tool reported onto its `execute_tool` span.
 *
 * Call this from the `finally` that closes the span, so a tool that threw
 * mid-run still stamps what it had recorded.
 */
export function dispatchSkillTelemetry(
  span: Span,
  scope: SkillToolScope,
): void {
  const skillTelemetry = scope.skillTelemetry;
  if (skillTelemetry === undefined || !shouldEmitExperimentalTelemetry()) {
    return;
  }
  try {
    switch (skillTelemetry.kind) {
      case 'load':
        traceSkillLoad(span, skillTelemetry);
        return;
      case 'resourceLoad':
        traceSkillResourceLoad(span, skillTelemetry);
        return;
      case 'scriptExecution':
        traceSkillScriptExecution(span, skillTelemetry);
        return;
    }
  } catch (e: unknown) {
    logger.warn(`Failed to record skill telemetry: ${formatError(e)}`);
  }
}

function traceSkillLoad(span: Span, skillTelemetry: SkillLoadTelemetry): void {
  const attributes: Attributes = {
    [ADK_EXPERIMENTAL_SKILL_NAME]:
      skillTelemetry.skillName.maybeHallucinatedValue,
  };

  const skill = skillTelemetry.skill;
  if (skill !== undefined) {
    attributes[ADK_EXPERIMENTAL_SKILL_DESCRIPTION] =
      skill.frontmatter.description;
    if (skill.uri !== undefined) {
      attributes[ADK_EXPERIMENTAL_SKILL_SOURCE_URI] = skill.uri;
    }
    const additionalTools = additionalToolsOf(skillTelemetry);
    if (additionalTools !== undefined) {
      attributes[ADK_EXPERIMENTAL_SKILL_ADDITIONAL_TOOLS] = additionalTools;
    }
  }

  span.setAttributes(attributes);
}

function traceSkillResourceLoad(
  span: Span,
  skillTelemetry: SkillResourceLoadTelemetry,
): void {
  const attributes: Attributes = {
    [ADK_EXPERIMENTAL_SKILL_NAME]:
      skillTelemetry.skillName.maybeHallucinatedValue,
    [ADK_EXPERIMENTAL_SKILL_RESOURCE_PATH]:
      skillTelemetry.resourcePath.maybeHallucinatedValue,
  };

  const uri = skillTelemetry.skill?.uri;
  if (uri !== undefined) {
    attributes[ADK_EXPERIMENTAL_SKILL_SOURCE_URI] = uri;
  }

  span.setAttributes(attributes);
}

function traceSkillScriptExecution(
  span: Span,
  skillTelemetry: SkillScriptExecutionTelemetry,
): void {
  const attributes: Attributes = {
    [ADK_EXPERIMENTAL_SKILL_NAME]:
      skillTelemetry.skillName.maybeHallucinatedValue,
    [ADK_EXPERIMENTAL_SKILL_SCRIPT_PATH]:
      skillTelemetry.scriptPath.maybeHallucinatedValue,
  };

  const exitCode = skillTelemetry.scriptExitCode;
  if (typeof exitCode === 'number') {
    attributes[ADK_EXPERIMENTAL_SKILL_SCRIPT_EXIT_CODE] = exitCode;
    if (exitCode !== 0) {
      attributes[ERROR_TYPE] = SKILL_SCRIPT_EXECUTION_ERROR;
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: SKILL_SCRIPT_EXECUTION_ERROR,
      });
    }
  }

  const uri = skillTelemetry.skill?.uri;
  if (uri !== undefined) {
    attributes[ADK_EXPERIMENTAL_SKILL_SOURCE_URI] = uri;
  }

  span.setAttributes(attributes);
}
