/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rendering metadata for a UI widget associated with an event.
 *
 * When present on an event's actions, the UI renders the widget using the
 * specified provider's renderer component.
 */
export interface UiWidget {
  /** The unique identifier of the UI widget. */
  id: string;

  /**
   * Widget provider identifier. Determines which rendering strategy the UI
   * uses.
   *
   * Known values:
   * - `'mcp'`: MCP App iframe, rendered with the MCP Apps AppBridge.
   */
  provider: string;

  /**
   * Provider-specific data required for rendering.
   *
   * For the `'mcp'` provider the payload carries `resource_uri` (a `ui://...`
   * URI), `tool` and `tool_args`. Keys are provider-defined and are never
   * case-converted, so they cross the wire exactly as written.
   */
  payload: Record<string, unknown>;
}
