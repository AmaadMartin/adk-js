/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {experimental} from '../../utils/experimental.js';
import {
  GoogleApiToolset,
  GoogleApiToolsetPresetOptions,
} from './google_api_toolset.js';

/**
 * Auto-generated BigQuery toolset, built from the BigQuery API v2
 * specification published by the Google API Discovery service.
 */
@experimental
export class BigQueryToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'bigquery', apiVersion: 'v2'});
  }
}

/**
 * Auto-generated Calendar toolset, built from the Google Calendar API v3
 * specification published by the Google API Discovery service.
 */
@experimental
export class CalendarToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'calendar', apiVersion: 'v3'});
  }
}

/**
 * Auto-generated Gmail toolset, built from the Gmail API v1 specification
 * published by the Google API Discovery service.
 */
@experimental
export class GmailToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'gmail', apiVersion: 'v1'});
  }
}

/**
 * Auto-generated YouTube toolset, built from the YouTube Data API v3
 * specification published by the Google API Discovery service.
 */
@experimental
export class YoutubeToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'youtube', apiVersion: 'v3'});
  }
}

/**
 * Auto-generated Slides toolset, built from the Google Slides API v1
 * specification published by the Google API Discovery service.
 */
@experimental
export class SlidesToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'slides', apiVersion: 'v1'});
  }
}

/**
 * Auto-generated Sheets toolset, built from the Google Sheets API v4
 * specification published by the Google API Discovery service.
 */
@experimental
export class SheetsToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'sheets', apiVersion: 'v4'});
  }
}

/**
 * Auto-generated Docs toolset, built from the Google Docs API v1
 * specification published by the Google API Discovery service.
 */
@experimental
export class DocsToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'docs', apiVersion: 'v1'});
  }
}
