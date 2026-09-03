/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/**
 * Ports `CodeConfig` from adk-python `google/adk/agents/common_configs.py`: a
 * variable, function or class referenced by its fully qualified name.
 */
export const codeConfigSchema = z.strictObject({name: z.string()});

/**
 * Ports `AgentRefConfig` from adk-python
 * `google/adk/agents/common_configs.py`: a sub-agent named either by config
 * file or by code reference, never both. Both messages are the wording
 * adk-python raises.
 */
export const agentRefConfigSchema = z
  .strictObject({
    configPath: z.string().optional(),
    code: z.string().optional(),
  })
  .check((ctx) => {
    const given = [ctx.value.code, ctx.value.configPath].filter(
      (value) => value !== undefined,
    ).length;
    if (given === 1) {
      return;
    }
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      message:
        given === 2
          ? 'Only one of `code` or `config_path` should be provided'
          : 'Exactly one of `code` or `config_path` must be provided',
    });
  });
