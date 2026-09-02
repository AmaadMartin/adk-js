/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The placeholder a fence writes over any marker string it finds inside the
 * text it fences, so quoted content cannot forge the end of its own block.
 *
 * The value reaches the model, so it must stay byte-identical to
 * `QUOTED_CONTENT_ELIDED` in `adk-python`'s `_fencing.py`.
 */
export const QUOTED_CONTENT_ELIDED = '<<<ELIDED_MARKER>>>';
