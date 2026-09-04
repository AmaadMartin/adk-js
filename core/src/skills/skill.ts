/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';

export const SNAKE_OR_KEBAB_NAME_PATTERN =
  /^([a-z0-9]+(-[a-z0-9]+)*|[a-z0-9]+(_[a-z0-9]+)*)$/;

export const KEBAB_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;

const NAME_TOO_LONG_MESSAGE = `name must be at most ${MAX_NAME_LENGTH} characters`;
const SNAKE_OR_KEBAB_NAME_MESSAGE =
  'name must be lowercase kebab-case (a-z, 0-9, hyphens) or snake_case (a-z, 0-9, underscores), with no leading, trailing, or consecutive delimiters. Mixing hyphens and underscores is not allowed.';
const KEBAB_NAME_MESSAGE =
  'name must be lowercase kebab-case (a-z, 0-9, hyphens), with no leading, trailing, or consecutive delimiters';
const DESCRIPTION_EMPTY_MESSAGE = 'description must not be empty';
const COMPATIBILITY_TOO_LONG_MESSAGE = `compatibility must be at most ${MAX_COMPATIBILITY_LENGTH} characters`;
const ADDITIONAL_TOOLS_MESSAGE =
  'adk_additional_tools must be a list of strings';
const INJECT_STATE_MESSAGE = 'adk_inject_state must be a bool';

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function validateName(value: string, ctx: z.RefinementCtx): void {
  if (value.length > MAX_NAME_LENGTH) {
    ctx.addIssue({code: 'custom', message: NAME_TOO_LONG_MESSAGE});
    return;
  }
  const snakeCaseAllowed = isFeatureEnabled(FeatureName.SNAKE_CASE_SKILL_NAME);
  const pattern = snakeCaseAllowed
    ? SNAKE_OR_KEBAB_NAME_PATTERN
    : KEBAB_NAME_PATTERN;
  if (!pattern.test(value)) {
    ctx.addIssue({
      code: 'custom',
      message: snakeCaseAllowed
        ? SNAKE_OR_KEBAB_NAME_MESSAGE
        : KEBAB_NAME_MESSAGE,
    });
  }
}

function validateDescription(value: string, ctx: z.RefinementCtx): void {
  if (!value) {
    ctx.addIssue({code: 'custom', message: DESCRIPTION_EMPTY_MESSAGE});
    return;
  }
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    ctx.addIssue({
      code: 'custom',
      message: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters. Description length: ${value.length}`,
    });
  }
}

function validateMetadata(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  if (
    'adk_additional_tools' in value &&
    !isStringArray(value['adk_additional_tools'])
  ) {
    ctx.addIssue({code: 'custom', message: ADDITIONAL_TOOLS_MESSAGE});
  }
  if (
    'adk_inject_state' in value &&
    typeof value['adk_inject_state'] !== 'boolean'
  ) {
    ctx.addIssue({code: 'custom', message: INJECT_STATE_MESSAGE});
  }
}

/**
 * Schema and Type for Skill Frontmatter metadata.
 */
export const FrontmatterSchema = z.preprocess(
  (data) => {
    if (typeof data !== 'object' || data === null) {
      return data;
    }
    const obj = data as Record<string, unknown>;
    const prepared = {...obj};
    if ('allowed-tools' in obj && !('allowedTools' in obj)) {
      prepared['allowedTools'] = obj['allowed-tools'];
    }
    // NFKC runs before validation so that the length and pattern checks see
    // the same characters adk-python sees.
    if (typeof obj['name'] === 'string') {
      prepared['name'] = obj['name'].normalize('NFKC');
    }
    return prepared;
  },
  z
    .object({
      name: z.string().superRefine(validateName),
      description: z.string().superRefine(validateDescription),
      license: z.string().optional(),
      compatibility: z
        .string()
        .max(MAX_COMPATIBILITY_LENGTH, {
          message: COMPATIBILITY_TOO_LONG_MESSAGE,
        })
        .optional(),
      'allowed-tools': z.string().optional(),
      metadata: z
        .record(z.string(), z.any())
        .default({})
        .superRefine(validateMetadata),
    })
    .loose(),
);

export interface Frontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Wrapper for script content.
 */
export interface Script {
  src: string;
}

/**
 * L3 skill content: additional instructions, assets, and scripts.
 */
export interface Resources {
  references?: Record<string, string | Buffer>;
  assets?: Record<string, string | Buffer>;
  scripts?: Record<string, Script>;
}

/**
 * Complete skill representation including frontmatter, instructions, and resources.
 */
export interface Skill {
  frontmatter: Frontmatter;
  instructions: string;
  resources?: Resources;
  /**
   * Location the skill was loaded from, used for telemetry. Should be
   * compliant with RFC 3986. Undefined when the load path cannot name one,
   * for example a skill loaded from an in-memory zip buffer.
   */
  uri?: string;
}

/**
 * Gets the content of a reference file.
 *
 * @param resources The skill resources to read from.
 * @param referenceId Unique path or name of the reference file.
 * @returns The reference content, or undefined if not found.
 */
export function getReference(
  resources: Resources | undefined,
  referenceId: string,
): string | Buffer | undefined {
  return resources?.references?.[referenceId];
}

/**
 * Gets the content of an asset file.
 *
 * @param resources The skill resources to read from.
 * @param assetId Unique path or name of the asset file.
 * @returns The asset content, or undefined if not found.
 */
export function getAsset(
  resources: Resources | undefined,
  assetId: string,
): string | Buffer | undefined {
  return resources?.assets?.[assetId];
}

/**
 * Gets a script file.
 *
 * @param resources The skill resources to read from.
 * @param scriptId Unique path or name of the script file.
 * @returns The script, or undefined if not found.
 */
export function getScript(
  resources: Resources | undefined,
  scriptId: string,
): Script | undefined {
  return resources?.scripts?.[scriptId];
}

/**
 * Lists all available reference paths.
 */
export function listReferences(resources: Resources | undefined): string[] {
  return Object.keys(resources?.references ?? {});
}

/**
 * Lists all available asset paths.
 */
export function listAssets(resources: Resources | undefined): string[] {
  return Object.keys(resources?.assets ?? {});
}

/**
 * Lists all available script paths.
 */
export function listScripts(resources: Resources | undefined): string[] {
  return Object.keys(resources?.scripts ?? {});
}

/**
 * Returns the skill name.
 */
export function getSkillName(skill: Skill): string {
  return skill.frontmatter.name;
}

/**
 * Returns the skill description.
 */
export function getSkillDescription(skill: Skill): string {
  return skill.frontmatter.description;
}

/**
 * Returns the script content as a string, so a script can be written to disk
 * or embedded in a prompt without reaching into its shape.
 */
export function scriptToString(script: Script): string {
  return script.src;
}
