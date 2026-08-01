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
 * Auto-generated BigQuery toolset based on the Google BigQuery API v2 spec
 * exposed by the Google API Discovery API.
 */
@experimental
export class BigQueryToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'bigquery', apiVersion: 'v2'});
  }
}

/**
 * Auto-generated Calendar toolset based on the Google Calendar API v3 spec
 * exposed by the Google API Discovery API.
 */
@experimental
export class CalendarToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'calendar', apiVersion: 'v3'});
  }
}

/**
 * Auto-generated Gmail toolset based on the Google Gmail API v1 spec exposed
 * by the Google API Discovery API.
 */
@experimental
export class GmailToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'gmail', apiVersion: 'v1'});
  }
}

/**
 * Auto-generated YouTube toolset based on the YouTube API v3 spec exposed by
 * the Google API Discovery API.
 */
@experimental
export class YoutubeToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'youtube', apiVersion: 'v3'});
  }
}

/**
 * Auto-generated Slides toolset based on the Google Slides API v1 spec
 * exposed by the Google API Discovery API.
 */
@experimental
export class SlidesToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'slides', apiVersion: 'v1'});
  }
}

/**
 * Auto-generated Sheets toolset based on the Google Sheets API v4 spec
 * exposed by the Google API Discovery API.
 */
@experimental
export class SheetsToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'sheets', apiVersion: 'v4'});
  }
}

/**
 * Auto-generated Docs toolset based on the Google Docs API v1 spec exposed by
 * the Google API Discovery API.
 */
@experimental
export class DocsToolset extends GoogleApiToolset {
  constructor(options: GoogleApiToolsetPresetOptions = {}) {
    super({...options, apiName: 'docs', apiVersion: 'v1'});
  }
}
