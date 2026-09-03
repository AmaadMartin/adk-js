/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {camelCaseKeys} from '../utils/case_utils.js';
import {isPlainObject} from '../utils/object_utils.js';

/**
 * Schema of the free key-value bag that holds a tool's constructor arguments.
 *
 * The accepted keys belong to the tool, not to ADK, so every key is kept. Keys
 * are camelCased before validation, at every depth.
 *
 * An agent config document camelCases its whole body, `tools[].args` included,
 * so this is the schema a caller applies to a bag it holds on its own.
 * {@link toolConfigSchema} keeps the bag verbatim instead, because the
 * declarative loader hands it to a factory the document names.
 *
 * @experimental
 */
export const toolArgsConfigSchema = z.preprocess(
  camelCaseKeys,
  z.looseObject({}),
);

/**
 * The base a custom tool's own config extends.
 *
 * The schema declares no key and rejects every key it was not extended with,
 * so a config built from it treats a misspelled key as an error rather than
 * as an extension point. A custom tool adds its keys with `.extend()`:
 *
 * ```ts
 * const myToolConfigSchema = baseToolConfigSchema.extend({
 *   threshold: z.number(),
 * });
 * myToolConfigSchema.parse({threshold: 1, thresold: 2}); // rejects the typo
 * ```
 *
 * This is the adk-python `BaseToolConfig` extension point, which carries
 * pydantic's `extra="forbid"` to a subclass.
 *
 * @experimental (Experimental, subject to change)
 */
export const baseToolConfigSchema = z.strictObject({});

/**
 * The config a custom tool declares by extending
 * {@link baseToolConfigSchema}.
 *
 * @experimental (Experimental, subject to change)
 */
export type BaseToolConfig = z.infer<typeof baseToolConfigSchema>;

/**
 * The declared args of one tool in a configuration file.
 *
 * A config comes from outside the type system, so the shape is whatever the
 * tool's own constructor, or the factory the tool names, accepts.
 * `BaseTool.fromConfig` checks the entries it reads and passes the rest
 * through.
 *
 * Structural (`object`) rather than an index signature on purpose: a subclass
 * that narrows {@link BaseTool.fromConfig} to its own config interface, or a
 * factory that narrows its parameter the same way, must stay assignable to
 * this type, and a TypeScript interface is not assignable to an
 * index-signature type.
 *
 * @experimental (Experimental, subject to change)
 */
export type ToolArgsConfig = object;

/**
 * Schema of one tool entry in a config document.
 *
 * `name` addresses the tool: a bare name for an ADK built-in tool such as
 * `google_search`, a fully qualified name such as
 * `my_package.my_module.my_tool` for a user-defined one, or the
 * `<module specifier>#<export>` form the declarative loader resolves, such as
 * `./my_tools.js#searchTool`. `args` carries the arguments for a tool that is
 * built from a class or a factory function.
 *
 * `args` is validated as an object and nothing more, mirroring adk-python's
 * `extra='allow'`: the keys belong to the tool, not to ADK, and they reach the
 * constructor or the factory exactly as the document writes them. A document
 * that wants them camelCased runs them through {@link toolArgsConfigSchema}.
 *
 * @experimental
 */
export const toolConfigSchema = z.strictObject({
  name: z.string().min(1),
  args: z
    .custom<ToolArgsConfig>(isPlainObject, {error: 'Expected an object.'})
    .optional(),
});

/**
 * One tool entry in a config document.
 *
 * `name` addresses the tool and `args` carries its settings. The five
 * supported ways to reference a tool, with examples, are in
 * `docs/guides/tools/tool_config/index.md`.
 *
 * @experimental
 */
export type ToolConfig = z.infer<typeof toolConfigSchema>;

// The schema of one standalone declaration, as {@link createToolConfig} reads
// it. It is not {@link toolConfigSchema}: an agent config document addresses a
// tool by a non-empty name, while a standalone declaration carries whatever
// name its caller wrote.
const toolDeclarationSchema = baseToolConfigSchema.extend({
  name: z.string(),
  args: z.looseObject({}).nullish(),
});

/**
 * Validates a parsed tool declaration and returns it as a {@link ToolConfig}.
 *
 * The input is whatever a YAML or JSON parse produced, so it is typed
 * `unknown` and every field is checked. A declaration comes from outside the
 * type system, so an undeclared key is a typo rather than an extension point,
 * and it is rejected instead of dropped in silence. `args` is copied, so the
 * returned config never aliases the caller's object.
 *
 * The error names the offending key and the expected type. It never echoes
 * the offending value, because a tool's args can carry credentials.
 *
 * This checks one standalone declaration. {@link toolConfigSchema} checks the
 * same entry inside an agent config document.
 *
 * @param value - The parsed tool declaration.
 * @returns A validated {@link ToolConfig}.
 * @throws {InputValidationError} When the declaration is not an object, when
 *   it carries a key {@link ToolConfig} does not declare, when `name` is
 *   missing or is not a string, or when `args` is not an object.
 *
 * @experimental
 */
export function createToolConfig(value: unknown): ToolConfig {
  const result = toolDeclarationSchema.safeParse(value);
  if (!result.success) {
    throw new InputValidationError(
      result.error.issues
        .map(
          (issue) =>
            `${issue.path.join('.') || 'ToolConfig'}: ${issue.message}`,
        )
        .join('; '),
    );
  }
  const {name, args} = result.data;
  return args == null ? {name} : {name, args};
}
