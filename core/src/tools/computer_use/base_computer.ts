/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The state of the computer environment after an action ran.
 *
 * Mirrors `ComputerState` in
 * `src/google/adk/tools/computer_use/base_computer.py` of `google/adk-python`.
 */
export interface ComputerState {
  /** The screenshot of the current screen, PNG-encoded. */
  screenshot: Uint8Array;

  /** The url of the page currently displayed. */
  url?: string;
}

/**
 * Whether `value` is a {@link ComputerState}.
 *
 * The check is structural and exact. A computer driver may return any payload,
 * and only a value that is exactly a state may be rewritten into the image
 * payload the model reads: a `{screenshot, error}` result rewritten that way
 * would silently drop its error. Python discriminates with `isinstance`, which
 * has no usable counterpart here — `instanceof` returns false between two
 * copies of adk-js in one runtime.
 */
export function isComputerState(value: unknown): value is ComputerState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('screenshot' in value) || !ArrayBuffer.isView(value.screenshot)) {
    return false;
  }
  const url = 'url' in value ? value.url : undefined;
  if (url !== undefined && typeof url !== 'string') {
    return false;
  }
  return Object.keys(value).every(
    (key) => key === 'screenshot' || key === 'url',
  );
}
