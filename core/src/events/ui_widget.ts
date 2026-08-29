/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rendering metadata for a UI widget attached to an event.
 *
 * A host that renders agent output looks for these on `EventActions` and draws
 * each one with the renderer its `provider` names.
 */
export interface UiWidget {
  /**
   * Identifies the widget within one event. A tool widget uses the id of the
   * function call that produced it.
   */
  id: string;

  /**
   * Selects the renderer. `'mcp'` is the MCP App iframe renderer.
   */
  provider: string;

  /**
   * Render data the provider understands. The `'mcp'` provider reads
   * `resource_uri`, `tool` and `tool_args`.
   */
  payload: Record<string, unknown>;
}
