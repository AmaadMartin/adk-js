/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rendering metadata for a UI widget attached to an event.
 *
 * When an event's actions carry a widget, a UI host renders it with the
 * renderer that {@link UiWidget.provider} names, alongside the agent response.
 */
export interface UiWidget {
  /** Unique identifier of the widget; the function call id for an MCP App. */
  id: string;

  /**
   * Rendering strategy the UI host selects on.
   *
   * Known values:
   * - `'mcp'`: an MCP App iframe, rendered with the MCP Apps AppBridge.
   */
  provider: string;

  /**
   * Provider-specific rendering data.
   *
   * For the `'mcp'` provider the keys are `resource_uri`, `tool` and
   * `tool_args`. They stay snake_case on purpose: the payload crosses the wire
   * verbatim, so a UI host reading an event from any ADK SDK sees one spelling.
   */
  payload: Record<string, unknown>;
}
