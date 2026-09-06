/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ADK-owned span attributes for the skill tools.
 *
 * These attributes are defined by ADK itself; they are not part of any
 * OpenTelemetry semantic convention. Everything named `adk.experimental.*`
 * carries no compatibility guarantee: an attribute may be renamed,
 * restructured, or removed in any release.
 */

import {trace} from '@opentelemetry/api';
import {Skill} from '../skills/skill.js';

const ADK_EXPERIMENTAL_SKILL_NAME = 'adk.experimental.skill.name';
const ADK_EXPERIMENTAL_SKILL_DESCRIPTION = 'adk.experimental.skill.description';
const ADK_EXPERIMENTAL_SKILL_SOURCE_URI = 'adk.experimental.skill.source.uri';
const ADK_EXPERIMENTAL_SKILL_ADDITIONAL_TOOLS =
  'adk.experimental.skill.additional_tools';
const ADK_EXPERIMENTAL_SKILL_RESOURCE_PATH =
  'adk.experimental.skill.resource.path';

const ADDITIONAL_TOOLS_METADATA_KEY = 'adk_additional_tools';

/** Narrows the untyped metadata value, which skips `FrontmatterSchema` when a `Skill` is built as an object literal. */
function additionalToolsOf(skill: Skill): string[] | undefined {
  const declared = skill.frontmatter.metadata?.[ADDITIONAL_TOOLS_METADATA_KEY];
  return Array.isArray(declared) &&
    declared.every((tool) => typeof tool === 'string')
    ? declared
    : undefined;
}

export interface TraceSkillLoadParams {
  /** Name the tool was asked for. Recorded even when the load failed. */
  skillName: string;
  /** The loaded skill, or undefined when the load produced none. */
  skill?: Skill;
}

/**
 * Stamps the skill load attributes onto the active `execute_tool` span.
 *
 * No span is created: the attributes land on the span
 * `callToolAsync` already opened around the tool call. The call is a no-op
 * when no span is active.
 */
export function traceSkillLoad({skillName, skill}: TraceSkillLoadParams): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  span.setAttribute(ADK_EXPERIMENTAL_SKILL_NAME, skillName);
  if (!skill) return;

  span.setAttribute(
    ADK_EXPERIMENTAL_SKILL_DESCRIPTION,
    skill.frontmatter.description,
  );
  if (skill.uri !== undefined) {
    span.setAttribute(ADK_EXPERIMENTAL_SKILL_SOURCE_URI, skill.uri);
  }
  const additionalTools = additionalToolsOf(skill);
  if (additionalTools !== undefined) {
    span.setAttribute(ADK_EXPERIMENTAL_SKILL_ADDITIONAL_TOOLS, additionalTools);
  }
}

export interface TraceSkillResourceLoadParams {
  /** Name of the skill the resource belongs to. */
  skillName: string;
  /** Path of the resource, recorded even when the load failed. */
  resourcePath: string;
  /** The loaded skill, or undefined when the load produced none. */
  skill?: Skill;
}

/**
 * Stamps the skill resource load attributes onto the active `execute_tool`
 * span.
 *
 * A resource load records neither the description nor the additional tools,
 * matching adk-python's `_trace_skill_resource_load`.
 */
export function traceSkillResourceLoad({
  skillName,
  resourcePath,
  skill,
}: TraceSkillResourceLoadParams): void {
  const span = trace.getActiveSpan();
  if (!span) return;

  span.setAttribute(ADK_EXPERIMENTAL_SKILL_NAME, skillName);
  if (skill?.uri !== undefined) {
    span.setAttribute(ADK_EXPERIMENTAL_SKILL_SOURCE_URI, skill.uri);
  }
  span.setAttribute(ADK_EXPERIMENTAL_SKILL_RESOURCE_PATH, resourcePath);
}
