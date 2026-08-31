/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rendering metadata for a UI widget attached to an event.
 *
 * Mirrors Python `google.adk.events.ui_widget.UiWidget`. The host UI reads
 * these off `EventActions.renderUiWidgets` and renders one surface per widget.
 */
export interface UiWidget {
  /** The widget's identifier, unique within one event's actions. */
  id: string;

  /**
   * The rendering strategy the host UI applies. `'mcp'` is an MCP App iframe
   * rendered with the MCP Apps AppBridge.
   */
  provider: string;

  /**
   * Provider-specific rendering data. For `'mcp'` the keys are
   * `resource_uri`, `tool` and `tool_args`.
   *
   * The keys stay snake_case because a host UI also reads events written by
   * adk-python, and both SDKs must produce the same payload.
   */
  payload: Record<string, unknown>;
}
