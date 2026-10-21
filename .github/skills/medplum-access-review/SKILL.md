---
name: medplum-access-review
description: "Use when reviewing Medplum AccessPolicy, ProjectMembership parameters, compartments, tenant isolation, write constraints, or CUI authorization boundaries. Produces findings and allow/deny cases, not policy changes or live requests."
user-invocable: true
disable-model-invocation: true
---
# Medplum Access Review

## Before Acting

Read [security boundaries](../references/security-boundaries.md),
[workspace rules](../../../AGENTS.md), and
[Medplum instructions](../../instructions/medplum.instructions.md).
Load [FHIR instructions](../../instructions/fhir-resources.instructions.md) for
resource policies. For CUI behavior, consult the applicable consumer repository's
local guidance when it is part of the workspace. This is a report-only review.

## Procedure

1. Confirm the sanitized input paths and expected role/resource/interaction/tenant
   matrix. If membership configuration is private, request a sanitized example;
   do not open private service config, credentials, or patient data.
2. Locate the policy, all task-relevant assigned policies, membership parameter
   bindings, caller, and neighboring tests. For an existing example, inspect
   clinical policy in the hiive-fhir-resources repository
   and helper tests in the hiive-fhir-resources repository.
   Verify relevant official documentation and installed SDK/server compatibility;
   an offline caller must report missing evidence rather than fetching it.
3. Check the effective combined permissions, including broad/wildcard grants,
   missing parameter bindings, supported criteria/search parameters, and
   read/search/history/vread/create/update/delete distinctions. Do not assume a
   restrictive policy cancels another grant or infer server behavior from a helper.
   Medplum documents only `:not` and `:missing` modifiers in AccessPolicy criteria,
   with no chained searches; general FHIR search support does not imply policy
   support. Check operation dependencies too: upserts need search/create/update,
   and reference resolution can require search/read permissions depending on
   conditional references and `Project.checkReferencesOnWrite`.
4. Trace each resource's own compartment-defining references. A link to an
   authorized resource, such as `Communication.partOf`, does not automatically
   authorize the child. Check Binary security context separately. Frontend
   filtering and banner display are not server authorization boundaries.
5. Inspect write constraints on creates and updates, missing `%before` on creation,
   immutable tenant/profile ownership, forbidden fields, and attempted removal of
   protected metadata. Examine invalid/missing references and profile URI
   lookalikes; local URI matching behavior is not proof of server enforcement.
6. If CUI is in scope, preserve authenticated server-derived project decisions,
   least-privilege configuration readers, validation failures, and `no-store`.
   Do not convert unavailable policy data into access or a disabled banner.
7. Propose synthetic allow/deny cases for same-tenant access, cross-tenant access,
   absent/wrong parameter bindings, direct ID reads versus search, write/patch,
   history/version reads, and missing compartment context. Include combinations
   of policies and unauthorized target changes, not only successful reads.
8. Label available evidence: source inspection, helper/mock tests, or separately
   authorized server-backed results. Do not run tests, log in, broaden policies,
   or mutate memberships from this skill. CUI live checks change configuration;
   they require explicit permission and a disposable local project.

## Output

Give severity-ordered findings with file locations, expected versus observed
permissions, minimal corrective recommendations, and a synthetic allow/deny
matrix. State which guarantees remain unverified and the prerequisites for live
checks. Report no issues clearly when none are supported by evidence.

## Example

Input: review a patient-scoped policy with a custom membership variable.
Expected: trace the binding and resource compartments, flag missing negative
coverage, and identify server checks still needed. Do not read a real membership
or claim passing helper tests establish tenant isolation.