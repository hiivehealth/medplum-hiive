# Red Rover Connector

Partial implementation for the first patient/encounter-to-unsigned-note round
trip. One live read-only UAT patient/encounter test passed on 2026-10-19 under the
owner-authorized temporary credential-risk exception; full round-trip acceptance
remains incomplete. Nothing runs on module import, no import
or export sender is supplied, and the HTTP client rejects clinical-write mode.

## Review Checkpoint

As of 2026-10-20, implementation is paused pending Red Rover's mapping review.
This feature branch is a work-in-progress checkpoint, not an approved mapping,
import, clinical-write or deployment release. Imports and clinical writes remain
blocked; do not resume integration work until the review is returned and assessed.

Vendor review materials are at the repository root:

- [Simplified mapping review](../../../../red-rover-mapping-review-simple.xlsx):
  the primary vendor review workbook, with one mapping per row and decision/comment columns.
- [Detailed mapping review](../../../../red-rover-mapping-review.xlsx): supporting
  definitions, questions and the mapped-field inventory.
- [Email draft](../../../../red-rover-mapping-review-email.md): detailed review
  request; use the simplified workbook as the primary attachment for quick review.
- [Integration plan](../../../../red-rover-integration-plan.md): design, verified
  evidence and remaining approval/runtime gates.

Credentials, retrieved patient data and private FHIR review drafts are intentionally
excluded from this checkpoint. Vendor workbooks contain field names and terminology
proposals, not patient chart values. Vendor responses are not yet mapping approval.

## Implementation Status

| Slice                | Implemented and checked offline                                                                                       | Remaining exit gates                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1. Isolate/configure | Separate feature worktree, UAT-only configuration, assigned patient allowlist, disabled writes                        | Rotate credentials; approve isolated project, access policy and durable ledger ownership                                       |
| 2. Connect read-only | OAuth grant, token caching, bounded requests; one live UAT OAuth/patient/encounter read passed                        | Token renewal and wider/repeated live-read behavior remain unverified                                                          |
| 3. Retrieve safely   | Envelope failures, exact patient identity, bounded ID-paged encounter GET, duplicate and cross-patient rejection      | Confirm site ID ordering and counts; validate authorized fixtures; other clinical endpoints remain unimplemented               |
| 4. Map/dry-run       | Patient/Encounter FHIR, stable source identifiers, explicit terminology maps, Provenance, private offline file runner | Clinical approval of codes/date semantics; additional chart mappings and security labels                                       |
| 5. Import            | Conditional-create transaction proposal, exact-plan Task ledger, version guard and reference rewriting                | No executor; provision protected ledger; prove rollback, concurrent claims, replay, read-back and recovery in isolated project |
| 6. Write-back        | Exact-version approval checks, unsigned note request conversion, uncertain-result/read-back transition policy         | No sender or durable delivery adapter; prove attribution, reconciliation, read-back and loop prevention live                   |
| 7. Expand/deploy     | No runtime deployment changes                                                                                         | Separately authorize workflows, cloud egress, secrets, monitoring, recovery and clinical acceptance                            |

Unit tests are evidence of local behavior, not proof of vendor capabilities,
Medplum transaction atomicity, concurrent delivery safety or clinical acceptance.

## Configuration

Pass a server-side environment object to `new RedRoverClient(environment)`.
Nothing runs on module import. Do not log the environment or client object.

| Variable                                  | Requirement                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `RED_ROVER_ENVIRONMENT`                   | Exactly `uat`                                                                                                        |
| `RED_ROVER_UAT_ENDPOINTS_CONFIRMED`       | Exactly `true`, only after vendor confirmation                                                                       |
| `RED_ROVER_API_BASE_URL`                  | Confirmed HTTPS API deployment prefix, excluding `/api/v2`; an existing `/uat` prefix is retained                    |
| `RED_ROVER_TOKEN_URL`                     | Confirmed complete HTTPS token URL                                                                                   |
| `RED_ROVER_CLIENT_ID`                     | Assigned client ID                                                                                                   |
| `RED_ROVER_CLIENT_SECRET`                 | Rotated secret from secure server-side storage                                                                       |
| `RED_ROVER_USER_ID`                       | Application user audit context, not an OAuth credential; the supplied guide permits `0` when no user context applies |
| `RED_ROVER_SCOPE`                         | Exactly `rrh/patientsEncounters:read`                                                                                |
| `RED_ROVER_PATIENT_IDS`                   | Comma-separated subset of assigned IDs: 19128435, 19128437, 19128439, 19128441, 19128443                             |
| `RED_ROVER_TIMEOUT_MS`                    | Optional integer 100-60000; default 15000                                                                            |
| `RED_ROVER_ENABLE_WRITES`                 | Unset or exactly `false`; enabling writes is rejected                                                                |
| `RED_ROVER_ENCOUNTER_ID_PAGING_CONFIRMED` | Exactly `true` before following an encounter ID cursor; otherwise truncated responses are rejected                   |

The confirmation flag is an operator assertion, not automatic detection of a
vendor's UAT hostname. Token and API URLs are separate and must both be checked.
OAuth uses form-encoded client credentials in HTTP Basic authorization and a
form-encoded client-credentials grant. Confirm this authentication method with
Red Rover before live use. Redirects are refused to prevent credential forwarding.

`getPatient(patientId)` is the low-level transport and returns untrusted `unknown`.
Use `getPatientRecord(patientId)` for an envelope-, count- and identity-checked
patient and `getEncounters(patientId)` for checked encounters. Both enforce the
configured allowlist before authentication. Tokens have a 30-second expiry margin.

The encounter reader follows at most 100 pages of requested size 100. It requires
accurate `returnedCount` and `totalCount`, matching patient IDs, unique encounter
IDs, and an advancing numeric ID cursor matching the last record. The route does
not declare sorting parameters: confirm ascending ID ordering for the site before
enabling the paging assertion. Date-based paging is not implemented. No partial
chart is returned on an error or page-limit failure. Missing metadata is rejected
even though the public schemas do not declare all fields required.

String encounter IDs are preserved without numeric conversion; numeric IDs must
be positive safe integers. The client cannot recover digits already rounded by an
upstream JSON producer. Envelope validation does not validate every clinical
field; mapping and FHIR validation are separate required boundaries.

Errors deliberately exclude response bodies, URLs, tokens and credential values.
They currently provide only the failing operation, not detailed HTTP diagnostics.
The timeout applies separately to each OAuth or clinical request. The client does
not retry automatically. A later explicit call can reacquire a token after a
transport failure.

## Guarded Sandbox Read

`preflightSandbox` checks local readiness without authenticating or contacting any
API. `runSandboxRead` requires explicit read authorization, retrieves the selected
patient and their encounters, and verifies that the expected encounter belongs to
that patient before storing a completed snapshot. Neither operation imports FHIR
or sends a clinical write. At 2026-10-19T18:57Z, OAuth and both GET requests
returned HTTP 200, patient identity and its expected encounter were verified,
and a completed snapshot was saved with file permissions `600` outside git.
The rotation flag stayed `"false"`; the temporary override was recorded in the
artifact. This proves one assigned UAT pair, not multi-page retrieval, FHIR
import, clinical write-back, external author attribution or production readiness.

Keep a JSON configuration file outside source control in an owner-only directory
(`700`), with file permissions `600`. It contains string-valued `RED_ROVER_*` keys
only. The runner never merges shell environment values or prints credentials.
Use the variables above plus these required operator assertions:

```json
{
  "RED_ROVER_ENVIRONMENT": "uat",
  "RED_ROVER_UAT_ENDPOINTS_CONFIRMED": "true",
  "RED_ROVER_API_BASE_URL": "https://vendor-confirmed-api.example.test/uat",
  "RED_ROVER_TOKEN_URL": "https://vendor-confirmed-auth.example.test/oauth2/token",
  "RED_ROVER_CLIENT_ID": "replace-privately",
  "RED_ROVER_CLIENT_SECRET": "replace-privately-with-rotated-secret",
  "RED_ROVER_USER_ID": "replace-with-approved-audit-identity",
  "RED_ROVER_SCOPE": "rrh/patientsEncounters:read",
  "RED_ROVER_PATIENT_IDS": "19128435",
  "RED_ROVER_ENABLE_WRITES": "false",
  "RED_ROVER_CREDENTIAL_ROTATION_CONFIRMED": "true",
  "RED_ROVER_READ_ACCESS_CONFIRMED": "true"
}
```

The example is not usable configuration. Set confirmation flags only after
rotation and vendor confirmation of endpoints, audit identity, cohort, scope,
authentication method and current whitelisted egress. Flags are operator
assertions, not automatic verification. Rotation remains the recommended response
to an exposed secret; the temporary read-only exception below does not revoke it.
The runner validates format but cannot distinguish placeholder or revoked
credentials from real credentials before contacting the vendor.

Build the runner from the example package with repository dependencies installed:

```sh
../../node_modules/.bin/esbuild src/red-rover/sandbox.ts --bundle --platform=node --format=cjs --packages=external --outfile=dist/red-rover/sandbox.cjs
```

Run a **no-network preflight** using only the private file path on the command line:

```sh
node -e 'require("./dist/red-rover/sandbox.cjs").preflightSandbox({configPath:process.argv[1],patientId:"19128435",expectedEncounterId:"61221038"}).then(()=>console.log("Local preflight passed; no network calls")).catch(()=>{console.error("Preflight failed; check private configuration");process.exitCode=1})' /private/path/red-rover.json
```

After readiness is confirmed, the following command **does contact Red Rover**:

```sh
node -e 'require("./dist/red-rover/sandbox.cjs").runSandboxRead({configPath:process.argv[1],outputPath:process.argv[2],patientId:"19128435",expectedEncounterId:"61221038",authorizeLiveRead:true}).then(()=>console.log("Validated read saved privately")).catch(()=>{console.error("Read failed; inspect readiness and protected artifacts");process.exitCode=1})' /private/path/red-rover.json /private/path/new-snapshot.json
```

### Temporary Unrotated-Credential Exception

After explicit owner acceptance of the exposure risk, a read-only UAT request may
include `unrotatedCredentialOverride: { acknowledgeExposure: true, expiresAt }`.
Use a canonical UTC ISO timestamp, for example
`new Date(Date.now() + 10 * 60 * 1000).toISOString()`. It must be in the future and
no more than 15 minutes away when the operation starts. The acknowledgment is
passed to that invocation, not stored in or inferred from the credential file.

Keep `RED_ROVER_CREDENTIAL_ROTATION_CONFIRMED` truthfully set to `"false"`.
Both preflight and the read invocation need the override. It only accepts the
documented `api-us-uat.redrover.health/uat` API prefix and
`api-us-uat-auth.redrover.health/oauth2/token` token endpoint over HTTPS.
All existing read-access, endpoint-confirmation, scope, cohort and write-disable
checks still apply. No import, write, production or background deployment is
authorized by this exception. Expiry gates starting a read; it does not revoke
an already issued token or guarantee cancellation of a read already in progress.

Artifacts record `credentialRiskOverrideUsed` and the acknowledgment/expiry,
never the secret. This is not proof of rotation or safety: an exposed credential
remains exposed. Do not add automatic renewal or unattended retry of this override.

Output must be a new file in an owner-only directory. The runner reserves it
before authentication, so an existing/symlink output fails without network access.
An unsuccessful run may leave an incomplete marker or partially written file;
only a fully parseable artifact with `status: "complete"` is usable. Do not
automatically retry a failed command. Diagnose the failure and choose a new output
path for an explicitly authorized subsequent read. Treat all artifacts as sensitive.

The output contains `snapshot`, recording time and a count-only report, never
credentials or OAuth tokens. To continue with the offline FHIR runner, construct
its input using this `snapshot` plus separately approved `policy` and `context`.
The read runner does not infer clinical code mappings or security policy.

## Mapping And Dry Run

`retrieveChart` uses the validated read methods. `prepareChart` maps a supplied
snapshot, validates each generated resource with Medplum, and returns a
**collection**, not an executable transaction. Index R4 type/resource definitions
before calling it; the file runner does this automatically.

Supply an owned, site/environment-specific HTTPS `identifierBase` with no trailing
slash, a `mappingRevision`, and explicit gender, Encounter class and status maps.
There are no production terminology defaults. Tests use synthetic mapping choices;
example Cerner numbers do not establish mappings for a real installation.

Patient mapping includes names, active state, birth/death information and gender.
Encounter mapping includes source identity, patient reference, mapped status/class,
source type coding, arrival/discharge period and reason text. Original class,
status and gender codings are preserved in extensions. Birth date uses the
source timestamp's calendar date, not its UTC-converted date; this policy requires
site approval. Registration time is not silently substituted for arrival.

Patient confidentiality/VIP controls are quarantined until a security mapping is
approved. Aliases, contacts, military data, locations, relationships and other
unmapped fields are reported by field name without copying their values to the
summary. They are not silently considered imported. Additional clinical resource
transforms are not implemented. The import proposal refuses unresolved fields.

FHIR identifiers and local draft IDs are source-scoped and deterministic. They
are not proof of an existing persisted crosswalk. Provenance records the supplied
agent, recording time and mapping/snapshot operation digest. Protect IDs and
digests as sensitive metadata, not as anonymized data.

### Snapshot Mapping Review

`runMappingReview(inputPath, outputPath)` reviews a previously completed sandbox
read offline. It does not load credentials, call APIs or import resources. It
uses the private-file protections below, requires a completed read-only artifact
and never overwrites output. Its report contains source terminology values;
keep the whole artifact private and do not print it to shared logs.

Recognized source displays produce **unapproved proposals**, not authoritative
code maps. Unknown or conflicting candidates produce a blocked report without
a bundle. Generated drafts use an `example.invalid` namespace and an explicitly
unprovisioned agent. Every resource is tagged `review-only-not-for-import`;
`report.mode` is `mapping-review`, `importAllowed` is `false`, and the import
ledger builder rejects this result. The strict mapper's confidentiality/VIP
quarantine is unchanged.

The review-only projection preserves source confidentiality/VIP codings, including
zero, in local Patient security labels. These are **not access enforcement** or
approved security translations. Provenance fingerprints the complete original
snapshot, including unmapped fields. Missing birth dates remain absent rather
than being inferred from age. Base-R4 validation does not establish terminology,
clinical fidelity, local profile compliance or authorization.

At `2026-10-19T19:06Z`, the saved UAT snapshot produced one Patient, one Encounter
and one Provenance with no base-R4 validation issues. There were 3 unapproved
terminology proposals, 22 unmapped root fields, 4 approval blockers and a missing
birth-date warning. The owner-only output stayed outside git; network access was
disabled and no resources were imported. Before import, approve terminology and
date semantics, implement confidentiality/VIP enforcement, replace placeholder
namespace/actor, and resolve every unmapped field (including military data,
identifiers/aliases, locations, admission/discharge details and coverage).

After building the offline runner using the command below:

```sh
node -e 'require("./dist/red-rover/offline.cjs").runMappingReview(process.argv[1],process.argv[2]).then(()=>console.log("Private review saved; import remains blocked")).catch(()=>{console.error("Review failed; details withheld");process.exitCode=1})' /private/path/completed-read.json /private/path/new-review.json
```

### Private File Runner

Prepare a private JSON input with exactly these root objects:

```json
{
  "snapshot": {
    "patientId": "19128435",
    "patient": { "patientId": 19128435 },
    "encounters": []
  },
  "policy": {
    "identifierBase": "https://example.test/red-rover/uat/site-a",
    "genderCodes": {},
    "encounterClassCodes": {},
    "encounterStatusCodes": {}
  },
  "context": {
    "recorded": "2026-10-19T10:00:00Z",
    "agentReference": "Device/connector",
    "mappingRevision": "patient-encounter-v1"
  }
}
```

Replace example namespace/agent with approved values. The minimal synthetic
example demonstrates the file format, not a complete clinical chart. Keep real
fixtures outside source control, owner-only (`600`) in a private directory (`700`).
The input limit is 20 MB. Output must be a new file in an existing owner-only
directory; symlink inputs and overwrites are refused. A failed disk write may
leave an incomplete private artifact, which must not be used as a successful run.

From the example package with repository dependencies installed:

```sh
../../node_modules/.bin/esbuild src/red-rover/offline.ts --bundle --platform=node --format=cjs --packages=external --outfile=dist/red-rover/offline.cjs
node -e 'require("./dist/red-rover/offline.cjs").runOffline(process.argv[1],process.argv[2]).then(()=>console.log("Dry run complete")).catch(()=>{console.error("Dry run failed");process.exitCode=1})' /private/path/input.json /private/path/new-chart.json
```

This performs no network calls. The output contains clinical FHIR data and must
remain protected. Run only one file job per process; definitions are indexed into
Medplum's process-global registry.

## Import Proposal

`prepareImportLedger` proposes a native Task bound to the exact bundle digest and
operation key. Provision, approve and protect one ledger Task per operation in
the isolated project; this module does not create it or prove uniqueness.
`prepareImportTransaction` requires its saved ID/version, requested state, owner
and unchanged inputs. It rewrites patient, encounter and Provenance references
to transaction fullUrls, uses conditional Patient/Encounter creates and includes
an `ifMatch`-guarded Task completion. It never overwrites existing clinical data.

The project IDs supplied to the builder are assertions, not authentication or
authorization. A future executor must independently verify its authenticated
project and least-privilege membership. It must preflight existing identifiers
for duplicates/content conflicts, require durable claim/transaction guarantees,
inspect **every** response entry and read persisted resources back. A conditional
create may reuse an existing resource without applying incoming changes; HTTP
success alone does not establish clinical fidelity. Do not blindly resubmit after
an uncertain or partial outcome. No restart/checkpoint recovery executor exists.

The native validator reports a known warning for a transaction `urn:uuid` patient
reference; tests assert that specific warning, not a warning-free transaction.
Individual mapped resources validate without issues before reference rewriting.

## Unsigned Note Preparation

`prepareUnsignedNote` accepts a local versioned preliminary DocumentReference,
persisted Patient/Encounter crosswalks, a version-specific approved Task and
site-approved template/type/author settings. It requires one inline UTF-8
`text/plain` attachment (maximum 256,000 decoded bytes), escapes it into XHTML
and base64-encodes the XHTML for `POST /api/v2/unsignedDynamicDocument`.
Rich HTML, URL attachments, signed/final notes, ambiguous authors, wrong patient
or encounter and imported-source notes are refused. The template and author
must still be validated for the actual site; there is no fallback author.

The returned packet contains clinical content. Its operation key binds the source
version and request, not an API idempotency header. Approval checking is structural:
a future sender must verify approver permissions, current source/Task versions,
current patient/encounter association and an atomic durable claim immediately
before sending. The module does not fetch approvals or provide a clinical sender.

`advanceDelivery` is a pure transition policy, **not a durable ledger**. It permits
one claim, sends uncertain outcomes to reconciliation, and requires matching
remote identity/content/unsigned read-back before completion. Its read-back flags
must come from actual validated evidence, never caller assumptions. No automated
remote-document discovery, normalization, retry loop or subscription is provided.

## Offline Verification

From `examples/medplum-demo-bots` with repository dependencies installed:

```sh
npm test -- src/red-rover/
```

Tests use synthetic records, native FHIR definitions, private temporary files and
mocked fetch responses only. They do not contact clinical systems. Focused
TypeScript and ESLint checks are also required. Lint is run with
`--rule 'header/header: off'` to honor the no-new-copyright-header instruction.

## Remaining Gates

- Rotate the starter-kit secret; confirm token/API URLs, authentication method,
  approved audit identity, scope, cohort and actual whitelisted outbound IP.
- Confirm envelope/count/paging behavior and validate authorized site fixtures.
- Approve terminology/date policies and implement remaining clinical mappings.
- Select/provision a protected native Task ledger and isolated Medplum project;
  prove concurrent claims, transaction rollback, replay and partial-outcome recovery.
- Implement guarded executors, persisted crosswalk/checkpoints, authenticated
  approval checks, live reconciliation/read-back and loop prevention.
- Authorize a single UAT unsigned-note write separately; verify its external
  identity, unsigned status and attribution before expanding or deploying.

The reviewed architecture document remains in the original workspace checkout
as `red-rover-integration-plan.md`; it has not been committed or moved into this
feature worktree. No live-read, import or clinical-write acceptance gate has
been met by the mocked tests.
