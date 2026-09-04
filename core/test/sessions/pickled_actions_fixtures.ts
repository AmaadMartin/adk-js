/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pickled `EventActions` payloads, as base64.
 *
 * Node cannot call `pickle.dumps`, so these were produced by CPython 3.13 and
 * pydantic 2.13.4 from stand-in models whose `__module__` and `__qualname__`
 * match `google/adk-python`'s. The byte stream therefore names exactly the
 * globals a payload written by a real adk-python v0 database names.
 *
 * To regenerate one, declare a Pydantic model with the fields listed in the
 * comment above the constant, set its `__module__` to the module named in the
 * payload, and print `base64.b64encode(pickle.dumps(value, protocol=P))`.
 */

/** `EventActions(state_delta={'skey': 4})`, protocol 5. */
export const SIMPLE_STATE_DELTA =
  'gAWVRwEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwSc2tpcF9zdW1tYXJpemF0aW9ulE6MC3N0YXRlX2RlbHRhlH2UjARza2V5lEsEc4wOYXJ0aWZhY3RfZGVsdGGUfZSMEXRyYW5zZmVyX3RvX2FnZW50lE6MCGVzY2FsYXRllE6MFnJlcXVlc3RlZF9hdXRoX2NvbmZpZ3OUfZSMHHJlcXVlc3RlZF90b29sX2NvbmZpcm1hdGlvbnOUfZSMCmNvbXBhY3Rpb26UTnWMEl9fcHlkYW50aWNfZXh0cmFfX5ROjBdfX3B5ZGFudGljX2ZpZWxkc19zZXRfX5SPlChoCJCMFF9fcHlkYW50aWNfcHJpdmF0ZV9flE51Yi4=';

/** The same actions at protocol 2, which spells globals and the memo differently. */
export const PROTOCOL_2 =
  'gAJjZ29vZ2xlLmFkay5ldmVudHMuZXZlbnRfYWN0aW9ucwpFdmVudEFjdGlvbnMKcQApgXEBfXECKFgIAAAAX19kaWN0X19xA31xBChYEgAAAHNraXBfc3VtbWFyaXphdGlvbnEFTlgLAAAAc3RhdGVfZGVsdGFxBn1xB1gEAAAAc2tleXEISwRzWA4AAABhcnRpZmFjdF9kZWx0YXEJfXEKWBEAAAB0cmFuc2Zlcl90b19hZ2VudHELTlgIAAAAZXNjYWxhdGVxDE5YFgAAAHJlcXVlc3RlZF9hdXRoX2NvbmZpZ3NxDX1xDlgcAAAAcmVxdWVzdGVkX3Rvb2xfY29uZmlybWF0aW9uc3EPfXEQWAoAAABjb21wYWN0aW9ucRFOdVgSAAAAX19weWRhbnRpY19leHRyYV9fcRJOWBcAAABfX3B5ZGFudGljX2ZpZWxkc19zZXRfX3ETY19fYnVpbHRpbl9fCnNldApxFF1xFWgGYYVxFlJxF1gUAAAAX19weWRhbnRpY19wcml2YXRlX19xGE51Yi4=';

/**
 * `EventActions(state_delta={'skey': 'updated'},
 * artifact_delta={'artifact.txt': 2})`, protocol 5.
 */
export const STATE_AND_ARTIFACT =
  'gAWVYwEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwSc2tpcF9zdW1tYXJpemF0aW9ulE6MC3N0YXRlX2RlbHRhlH2UjARza2V5lIwHdXBkYXRlZJRzjA5hcnRpZmFjdF9kZWx0YZR9lIwMYXJ0aWZhY3QudHh0lEsCc4wRdHJhbnNmZXJfdG9fYWdlbnSUTowIZXNjYWxhdGWUTowWcmVxdWVzdGVkX2F1dGhfY29uZmlnc5R9lIwccmVxdWVzdGVkX3Rvb2xfY29uZmlybWF0aW9uc5R9lIwKY29tcGFjdGlvbpROdYwSX19weWRhbnRpY19leHRyYV9flE6MF19fcHlkYW50aWNfZmllbGRzX3NldF9flI+UKGgIaAyQjBRfX3B5ZGFudGljX3ByaXZhdGVfX5ROdWIu';

/** `EventActions(state_delta={'skey': 4}, escalate=True)`, protocol 5. */
export const ESCALATE =
  'gAWVSQEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwSc2tpcF9zdW1tYXJpemF0aW9ulE6MC3N0YXRlX2RlbHRhlH2UjARza2V5lEsEc4wOYXJ0aWZhY3RfZGVsdGGUfZSMEXRyYW5zZmVyX3RvX2FnZW50lE6MCGVzY2FsYXRllIiMFnJlcXVlc3RlZF9hdXRoX2NvbmZpZ3OUfZSMHHJlcXVlc3RlZF90b29sX2NvbmZpcm1hdGlvbnOUfZSMCmNvbXBhY3Rpb26UTnWMEl9fcHlkYW50aWNfZXh0cmFfX5ROjBdfX3B5ZGFudGljX2ZpZWxkc19zZXRfX5SPlChoCGgOkIwUX19weWRhbnRpY19wcml2YXRlX1+UTnViLg==';

/**
 * Nested ADK and `google.genai` models, protocol 5:
 * `EventActions(requested_tool_confirmations={'fc-confirm':
 * ToolConfirmation(hint='Authorize execution?')},
 * compaction=EventCompaction(start_timestamp=1.0, end_timestamp=2.0,
 * compacted_content=Content(parts=[Part(text='summary')], role='model')))`.
 */
export const NESTED =
  'gAWV2wIAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwSc2tpcF9zdW1tYXJpemF0aW9ulE6MC3N0YXRlX2RlbHRhlH2UjA5hcnRpZmFjdF9kZWx0YZR9lIwRdHJhbnNmZXJfdG9fYWdlbnSUTowIZXNjYWxhdGWUTowWcmVxdWVzdGVkX2F1dGhfY29uZmlnc5R9lIwccmVxdWVzdGVkX3Rvb2xfY29uZmlybWF0aW9uc5R9lIwKZmMtY29uZmlybZSMImdvb2dsZS5hZGsudG9vbHMudG9vbF9jb25maXJtYXRpb26UjBBUb29sQ29uZmlybWF0aW9ulJOUKYGUfZQoaAV9lCiMBGhpbnSUjBRBdXRob3JpemUgZXhlY3V0aW9uP5SMCWNvbmZpcm1lZJSJdYwSX19weWRhbnRpY19leHRyYV9flE6MF19fcHlkYW50aWNfZmllbGRzX3NldF9flI+UKGgZkIwUX19weWRhbnRpY19wcml2YXRlX1+UTnVic4wKY29tcGFjdGlvbpRoAIwPRXZlbnRDb21wYWN0aW9ulJOUKYGUfZQoaAV9lCiMD3N0YXJ0X3RpbWVzdGFtcJRHP/AAAAAAAACMDWVuZF90aW1lc3RhbXCUR0AAAAAAAAAAjBFjb21wYWN0ZWRfY29udGVudJSMEmdvb2dsZS5nZW5haS50eXBlc5SMB0NvbnRlbnSUk5QpgZR9lChoBX2UKIwFcGFydHOUXZRoKYwEUGFydJSTlCmBlH2UKGgFfZSMBHRleHSUjAdzdW1tYXJ5lHNoHE5oHY+UKGg2kGgfTnViYYwEcm9sZZSMBW1vZGVslHVoHE5oHY+UKGg5aC+QaB9OdWJ1aBxOaB2PlChoKGgnaCaQaB9OdWJ1aBxOaB2PlChoIGgQkGgfTnViLg==';

/**
 * `EventActions(state_delta={'last_seen': datetime(2026, 1, 1, 12, 30,
 * tzinfo=timezone.utc)})`, protocol 5.
 */
export const DATETIME_STATE_DELTA =
  'gAWVoAEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVudEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwSc2tpcF9zdW1tYXJpemF0aW9ulE6MC3N0YXRlX2RlbHRhlH2UjAlsYXN0X3NlZW6UjAhkYXRldGltZZSMCGRhdGV0aW1llJOUQwoH6gEBDB4AAAAAlGgLjAh0aW1lem9uZZSTlGgLjAl0aW1lZGVsdGGUk5RLAEsASwCHlFKUhZRSlIaUUpRzjA5hcnRpZmFjdF9kZWx0YZR9lIwRdHJhbnNmZXJfdG9fYWdlbnSUTowIZXNjYWxhdGWUTowWcmVxdWVzdGVkX2F1dGhfY29uZmlnc5R9lIwccmVxdWVzdGVkX3Rvb2xfY29uZmlybWF0aW9uc5R9lIwKY29tcGFjdGlvbpROdYwSX19weWRhbnRpY19leHRyYV9flE6MF19fcHlkYW50aWNfZmllbGRzX3NldF9flI+UKGgIkIwUX19weWRhbnRpY19wcml2YXRlX1+UTnViLg==';

/**
 * A hostile payload: `builtins.exec` applied to a string that would set an
 * environment variable if anything ran it. Protocol 5.
 */
export const EVIL_EXEC =
  'gAWVUQAAAAAAAACMCGJ1aWx0aW5zlIwEZXhlY5STlIw1aW1wb3J0IG9zOyBvcy5lbnZpcm9uWydBREtfTUlHUkFUSU9OX1BJQ0tMRV9SQ0UnXT0nMSeUhZRSlC4=';
