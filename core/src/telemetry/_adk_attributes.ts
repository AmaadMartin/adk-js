/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Span attribute names that ADK owns.
 *
 * These attributes are defined by ADK itself. They are not part of any
 * OpenTelemetry semantic convention.
 *
 * Everything named `adk.experimental.*` is emitted only when experimental
 * telemetry is enabled, and carries no compatibility guarantee: an attribute
 * can be renamed, restructured or removed in any release.
 *
 * The names are a wire contract shared with `google/adk-python`. Ported from
 * `src/google/adk/telemetry/_adk_attributes.py` at
 * `b0180620f4c2f4f4467a89c37a30f75bf849700b`.
 */

export const ADK_EXPERIMENTAL_SKILL_NAME = 'adk.experimental.skill.name';
export const ADK_EXPERIMENTAL_SKILL_DESCRIPTION =
  'adk.experimental.skill.description';
export const ADK_EXPERIMENTAL_SKILL_ADDITIONAL_TOOLS =
  'adk.experimental.skill.additional_tools';
export const ADK_EXPERIMENTAL_SKILL_SOURCE_URI =
  'adk.experimental.skill.source.uri';
export const ADK_EXPERIMENTAL_SKILL_RESOURCE_PATH =
  'adk.experimental.skill.resource.path';
export const ADK_EXPERIMENTAL_SKILL_SCRIPT_PATH =
  'adk.experimental.skill.script.path';
export const ADK_EXPERIMENTAL_SKILL_SCRIPT_EXIT_CODE =
  'adk.experimental.skill.script.exit_code';
