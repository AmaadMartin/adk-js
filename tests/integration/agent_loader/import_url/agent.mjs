/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseAgent} from '@google/adk';

class UrlProbeAgent extends BaseAgent {}

export const rootAgent = new UrlProbeAgent({
  name: 'url_probe',
  description: import.meta.url,
});
