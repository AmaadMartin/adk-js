/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rendering metadata for a UI widget associated with an event.
 *
 * When present on {@link EventActions.renderUiWidgets}, the UI host renders the
 * widget with the renderer its `provider` names.
 */
export interface UiWidget {
  /** The unique identifier of the UI widget. */
  id: string;

  /**
   * Widget provider identifier. Determines which rendering strategy the UI
   * host uses.
   *
   * Known values:
   *   - `'mcp'`: an MCP App iframe, rendered with the MCP Apps AppBridge.
   */
  provider: string;

  /**
   * Provider-specific data required for rendering.
   *
   * The `'mcp'` provider fills it with `resource_uri`, `tool` and `tool_args`.
   * The keys are snake_case because the payload crosses to a UI host that both
   * ADK SDKs feed, so both must emit one spelling. Another provider defines
   * its own keys.
   */
  payload: Record<string, unknown>;
}
