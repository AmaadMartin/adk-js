/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pickled `EventActions` payloads CPython produced, so the legacy codec is
 * tested against what adk-python actually wrote into an `events.actions`
 * column.
 *
 * Every payload is the base64 of `pickle.dumps(value, 4)` on CPython 3.13.15
 * with pydantic 2.13.4. The models are stand-ins registered under the
 * adk-python module names, so the payload records the globals a real database
 * holds:
 *
 * ```python
 * import sys, types, pydantic
 *
 * def module(name):
 *   sys.modules[name] = types.ModuleType(name)
 *   return sys.modules[name]
 *
 * # Each class below is defined with the fields adk-python declares, then
 * # assigned onto the stand-in module and given its __module__:
 * #   google.adk.auth.auth_credential: HttpCredentials, HttpAuth, OAuth2Auth,
 * #     AuthCredentialTypes, AuthCredential
 * #   google.adk.auth.auth_schemes:    OpenIdConnectWithConfig
 * #   google.adk.auth.auth_tool:       AuthConfig
 * #   google.adk.tools.tool_confirmation: ToolConfirmation
 * #   google.adk.events.event_actions: EventActions
 * #   google.genai.types:              Outcome
 *
 * populated = EventActions(
 *     skip_summarization=True,
 *     state_delta={"user:name": "Ada", "count": 3, "nested": {"a": [1, 2]},
 *                  "outcome": Outcome.OUTCOME_OK},
 *     artifact_delta={"report.txt": 2},
 *     transfer_to_agent="analyst",
 *     escalate=True,
 *     requested_auth_configs={"call-1": auth_config},
 *     requested_tool_confirmations={"call-1": ToolConfirmation(
 *         hint="approve?", confirmed=True, payload={"key": "value"})},
 *     agent_state={"step": "done"},
 *     end_of_agent=True,
 *     rewind_before_invocation_id="invocation-1")
 *
 * stdlib_state = EventActions(state_delta={
 *     "ordered_dict": collections.OrderedDict(a=1, b=2),
 *     "default_dict": collections.defaultdict(list, a=[1]),
 *     "date": datetime.date(2026, 1, 1),
 *     "time": datetime.time(12, 30),
 *     "time_tz": datetime.time(12, 30, tzinfo=datetime.timezone.utc),
 *     "datetime_naive": datetime.datetime(2026, 1, 2, 3, 4, 5, 123456),
 *     "datetime_tz": datetime.datetime(2026, 1, 2, 3, 4, 5, 123456,
 *         tzinfo=datetime.timezone(datetime.timedelta(hours=5))),
 *     "timedelta": datetime.timedelta(seconds=1),
 *     "uuid": uuid.UUID("12345678-1234-5678-1234-567812345678"),
 *     "decimal": decimal.Decimal("1.5"),
 *     "pure_path": pathlib.PurePosixPath("/data/x.txt"),
 *     "windows_path": pathlib.PureWindowsPath("C:/a/b.txt"),
 *     "complex": complex(1, 2), "bytes": b"value", "tuple": (1, 2),
 *     "set": {1, 2}})
 *
 * def _detonate():
 *   return "boom"
 *
 * class _Payload:
 *   def __reduce__(self):
 *     return (_detonate, ())
 *
 * emit("POPULATED_ACTIONS_PAYLOAD", populated)
 * emit("EMPTY_ACTIONS_PAYLOAD", EventActions())
 * emit("STDLIB_STATE_ACTIONS_PAYLOAD", stdlib_state)
 * emit("DETONATING_PAYLOAD", _Payload())
 * ```
 */

/**
 * An `EventActions` with every field adk-js declares, plus
 * `rewind_before_invocation_id`, which only adk-python has.
 */
export const POPULATED_ACTIONS_PAYLOAD =
  'gASVswUAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVu' +
  'dEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwSc2tpcF9zdW1tYXJpemF0aW9u' +
  'lIiMC3N0YXRlX2RlbHRhlH2UKIwJdXNlcjpuYW1llIwDQWRhlIwFY291bnSUSwOMBm5l' +
  'c3RlZJR9lIwBYZRdlChLAUsCZXOMB291dGNvbWWUjBJnb29nbGUuZ2VuYWkudHlwZXOU' +
  'jAdPdXRjb21llJOUjApPVVRDT01FX09LlIWUUpR1jA5hcnRpZmFjdF9kZWx0YZR9lIwK' +
  'cmVwb3J0LnR4dJRLAnOMEXRyYW5zZmVyX3RvX2FnZW50lIwHYW5hbHlzdJSMCGVzY2Fs' +
  'YXRllIiMFnJlcXVlc3RlZF9hdXRoX2NvbmZpZ3OUfZSMBmNhbGwtMZSMGWdvb2dsZS5h' +
  'ZGsuYXV0aC5hdXRoX3Rvb2yUjApBdXRoQ29uZmlnlJOUKYGUfZQoaAV9lCiMC2F1dGhf' +
  'c2NoZW1llIwcZ29vZ2xlLmFkay5hdXRoLmF1dGhfc2NoZW1lc5SMF09wZW5JZENvbm5l' +
  'Y3RXaXRoQ29uZmlnlJOUKYGUfZQoaAV9lCiMFmF1dGhvcml6YXRpb25fZW5kcG9pbnSU' +
  'jBhodHRwczovL2V4YW1wbGUuY29tL2F1dGiUjA50b2tlbl9lbmRwb2ludJSMGWh0dHBz' +
  'Oi8vZXhhbXBsZS5jb20vdG9rZW6UjAZzY29wZXOUXZSMBm9wZW5pZJRhdYwSX19weWRh' +
  'bnRpY19leHRyYV9flE6MF19fcHlkYW50aWNfZmllbGRzX3NldF9flI+UKGguaDBoMpCM' +
  'FF9fcHlkYW50aWNfcHJpdmF0ZV9flE51YowTcmF3X2F1dGhfY3JlZGVudGlhbJSMH2dv' +
  'b2dsZS5hZGsuYXV0aC5hdXRoX2NyZWRlbnRpYWyUjA5BdXRoQ3JlZGVudGlhbJSTlCmB' +
  'lH2UKGgFfZQojAlhdXRoX3R5cGWUaDqME0F1dGhDcmVkZW50aWFsVHlwZXOUk5SMDnNl' +
  'cnZpY2VBY2NvdW50lIWUUpSMBGh0dHCUaDqMCEh0dHBBdXRolJOUKYGUfZQoaAV9lCiM' +
  'BnNjaGVtZZSMBmJlYXJlcpSMC2NyZWRlbnRpYWxzlGg6jA9IdHRwQ3JlZGVudGlhbHOU' +
  'k5QpgZR9lChoBX2UjAV0b2tlbpRoVHNoNU5oNo+UKGhUkGg4TnVidWg1Tmg2j5QoaExo' +
  'TpBoOE51YowGb2F1dGgylGg6jApPQXV0aDJBdXRolJOUKYGUfZQoaAV9lCiMCWNsaWVu' +
  'dF9pZJSMCWNsaWVudC1pZJSMDWNsaWVudF9zZWNyZXSUjAZzZWNyZXSUdWg1Tmg2j5Qo' +
  'aF1oX5BoOE51YnVoNU5oNo+UKGhXaEZoQJBoOE51YowOY3JlZGVudGlhbF9rZXmUjA5h' +
  'ZGtfb3BlbmlkX2tleZR1aDVOaDaPlChoJ2g5aGOQaDhOdWJzjBxyZXF1ZXN0ZWRfdG9v' +
  'bF9jb25maXJtYXRpb25zlH2UaCCMImdvb2dsZS5hZGsudG9vbHMudG9vbF9jb25maXJt' +
  'YXRpb26UjBBUb29sQ29uZmlybWF0aW9ulJOUKYGUfZQoaAV9lCiMBGhpbnSUjAhhcHBy' +
  'b3ZlP5SMCWNvbmZpcm1lZJSIjAdwYXlsb2FklH2UjANrZXmUjAV2YWx1ZZRzdWg1Tmg2' +
  'j5QoaHBocWhukGg4TnVic4wLYWdlbnRfc3RhdGWUfZSMBHN0ZXCUjARkb25llHOMDGVu' +
  'ZF9vZl9hZ2VudJSIjBtyZXdpbmRfYmVmb3JlX2ludm9jYXRpb25faWSUjAxpbnZvY2F0' +
  'aW9uLTGUdWg1Tmg2j5QoaB5oZmgHaBtoCGgdaHZoe2gYaHqQaDhOdWIu';

/** A default `EventActions`, whose every field is `None` or empty. */
export const EMPTY_ACTIONS_PAYLOAD =
  'gASVaQEAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVu' +
  'dEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwSc2tpcF9zdW1tYXJpemF0aW9u' +
  'lE6MC3N0YXRlX2RlbHRhlH2UjA5hcnRpZmFjdF9kZWx0YZR9lIwRdHJhbnNmZXJfdG9f' +
  'YWdlbnSUTowIZXNjYWxhdGWUTowWcmVxdWVzdGVkX2F1dGhfY29uZmlnc5R9lIwccmVx' +
  'dWVzdGVkX3Rvb2xfY29uZmlybWF0aW9uc5R9lIwLYWdlbnRfc3RhdGWUTowMZW5kX29m' +
  'X2FnZW50lE6MG3Jld2luZF9iZWZvcmVfaW52b2NhdGlvbl9pZJROdYwSX19weWRhbnRp' +
  'Y19leHRyYV9flE6MF19fcHlkYW50aWNfZmllbGRzX3NldF9flI+UjBRfX3B5ZGFudGlj' +
  'X3ByaXZhdGVfX5ROdWIu';

/** A `state_delta` holding each standard-library type the allowlist admits. */
export const STDLIB_STATE_ACTIONS_PAYLOAD =
  'gASVLgQAAAAAAACMH2dvb2dsZS5hZGsuZXZlbnRzLmV2ZW50X2FjdGlvbnOUjAxFdmVu' +
  'dEFjdGlvbnOUk5QpgZR9lCiMCF9fZGljdF9flH2UKIwSc2tpcF9zdW1tYXJpemF0aW9u' +
  'lE6MC3N0YXRlX2RlbHRhlH2UKIwMb3JkZXJlZF9kaWN0lIwLY29sbGVjdGlvbnOUjAtP' +
  'cmRlcmVkRGljdJSTlClSlCiMAWGUSwGMAWKUSwJ1jAxkZWZhdWx0X2RpY3SUjAtjb2xs' +
  'ZWN0aW9uc5SMC2RlZmF1bHRkaWN0lJOUjAhidWlsdGluc5SMBGxpc3SUk5SFlFKUaA9d' +
  'lEsBYXOMBGRhdGWUjAhkYXRldGltZZSMBGRhdGWUk5RDBAfqAQGUhZRSlIwEdGltZZRo' +
  'HIwEdGltZZSTlEMGDB4AAAAAlIWUUpSMB3RpbWVfdHqUaCRDBgweAAAAAJRoHIwIdGlt' +
  'ZXpvbmWUk5RoHIwJdGltZWRlbHRhlJOUSwBLAEsAh5RSlIWUUpSGlFKUjA5kYXRldGlt' +
  'ZV9uYWl2ZZRoHIwIZGF0ZXRpbWWUk5RDCgfqAQIDBAUB4kCUhZRSlIwLZGF0ZXRpbWVf' +
  'dHqUaDZDCgfqAQIDBAUB4kCUaCtoLUsATVBGSwCHlFKUhZRSlIaUUpSMCXRpbWVkZWx0' +
  'YZRoLUsASwFLAIeUUpSMBHV1aWSUaEWMBFVVSUSUk5QpgZR9lIwDaW50lIoQeFY0EnhW' +
  'NBJ4VjQSeFY0EnNijAdkZWNpbWFslIwHZGVjaW1hbJSMB0RlY2ltYWyUk5SMAzEuNZSF' +
  'lFKUjAlwdXJlX3BhdGiUjA5wYXRobGliLl9sb2NhbJSMDVB1cmVQb3NpeFBhdGiUk5SM' +
  'Cy9kYXRhL3gudHh0lIWUUpSMDHdpbmRvd3NfcGF0aJRoU4wPUHVyZVdpbmRvd3NQYXRo' +
  'lJOUjApDOi9hL2IudHh0lIWUUpSMB2NvbXBsZXiUaBWMB2NvbXBsZXiUk5RHP/AAAAAA' +
  'AABHQAAAAAAAAACGlFKUjAVieXRlc5RDBXZhbHVllIwFdHVwbGWUSwFLAoaUjANzZXSU' +
  'j5QoSwFLApB1jA5hcnRpZmFjdF9kZWx0YZR9lIwRdHJhbnNmZXJfdG9fYWdlbnSUTowI' +
  'ZXNjYWxhdGWUTowWcmVxdWVzdGVkX2F1dGhfY29uZmlnc5R9lIwccmVxdWVzdGVkX3Rv' +
  'b2xfY29uZmlybWF0aW9uc5R9lIwLYWdlbnRfc3RhdGWUTowMZW5kX29mX2FnZW50lE6M' +
  'G3Jld2luZF9iZWZvcmVfaW52b2NhdGlvbl9pZJROdYwSX19weWRhbnRpY19leHRyYV9f' +
  'lE6MF19fcHlkYW50aWNfZmllbGRzX3NldF9flI+UKGgIkIwUX19weWRhbnRpY19wcml2' +
  'YXRlX1+UTnViLg==';

/**
 * A payload that calls a module-level function when Python loads it.
 *
 * Mirrors `_Payload` in adk-python's test for the restricted unpickler.
 */
export const DETONATING_PAYLOAD =
  'gASVHQAAAAAAAACMCF9fbWFpbl9flIwJX2RldG9uYXRllJOUKVKULg==';

/** Decodes a base64 fixture into the bytes the `actions` column holds. */
export function actionsBlob(base64Payload: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64Payload, 'base64'));
}
