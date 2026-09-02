/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A reference to another agent from a config file. Exactly one field is set.
 *
 * Mirrors adk-python's `AgentRefConfig`.
 */
export interface AgentRefConfig {
  /**
   * Config file path of the referenced agent, relative to the referencing
   * config file.
   */
  configPath?: string;

  /**
   * Fully-qualified name (`<module specifier>#<export>`) of an agent instance
   * defined in code.
   */
  code?: string;
}
