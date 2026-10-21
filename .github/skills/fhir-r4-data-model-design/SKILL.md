---
name: fhir-r4-data-model-design
description: "Use when turning Hiive clinical or administrative requirements into an R4 resource model, relationships, lifecycle, profiles, extensions, or terminology bindings. Produces a reviewed design, not implementation or automatic document replacement."
user-invocable: true
disable-model-invocation: true
---
# FHIR R4 Data Model Design

## Before Acting

Read [security boundaries](../references/security-boundaries.md),
[workspace rules](../../../AGENTS.md),
[FHIR instructions](../../instructions/fhir-resources.instructions.md), and
[Medplum instructions](../../instructions/medplum.instructions.md).
Work from requirements and synthetic examples, not patient records. This is a
design/report workflow, not permission to persist or overwrite planning documents.

## Procedure

1. Identify actors, business events, ownership, inputs/outputs, relationships,
   retention/audit needs, and queries. Separate clinical facts from operational
   state and derived results. State assumptions and unresolved clinical decisions
   rather than making them on behalf of a clinician.
2. Verify resource/element/datatype choices against FHIR 4.0.1 (R4) definitions,
   installed `@medplum/fhirtypes`/`@medplum/core`, and relevant approved official
   Medplum documentation. An SDK release is not a FHIR version. Do not introduce
   R4B/R5 fields, operations, or unsupported search parameters from newer docs.
3. Inspect SUSHI configuration in the hiive-fhir-resources repository
   and catalog conventions in the hiive-fhir-resources repository.
   Prefer existing shared/tenant profiles and extensions; preserve canonical URLs,
   dependency pins, and stable identifiers. Create a profile when the use case
   needs constraints on existing R4 elements, such as cardinalities, bindings,
   slicing or invariants, without relaxing inherited rules. Introduce an extension
   only for data that no suitable standard element or reusable extension represents.
4. For each proposed resource, specify its purpose, required fields/cardinalities,
   lifecycle/status, reference targets, stable business identity, source ownership,
   create/update actor, and version/conflict behavior. Identify compartment-defining
   references and tenant attribution on each resource; links do not propagate
   authorization automatically. Model identifier fields and systems where needed,
   but use synthetic values in examples. Do not put real patient identifiers or
   other PHI into examples, resource IDs, canonical URLs or diagnostic output.
5. Use terminology stewardship in the hiive-fhir-resources repository
   for systems, codes, displays, versions, value sets, and binding strengths.
   Cite authoritative verification. If unavailable, label the mapping unverified;
   do not invent a clinical code or present a display string as a coded concept.
6. Define interactions and required searches, not just resource shapes. Check
   Medplum-specific messaging, scheduling, Binary storage, Questionnaire extraction,
   and subscription conventions when relevant. Describe transactions and partial
   effects with required feature flags; do not assume dependency order is atomic.
7. Propose FSH/profile invariants, valid/invalid synthetic instances, reference and
   terminology checks, and role-based allow/deny cases. Separate local validation
   from deployed-server guarantees. Refer implementation to the owning workspace
   only when the user requests it; do not run builds or live queries in this skill.

## Output

Give a resource/relationship table, lifecycle and ownership decisions, terminology
evidence, proposed profile/extension gaps, supported queries/interactions, and
validation/authorization cases. Cite R4 and local evidence, identify assumptions,
and label any unverified feature. Render in chat unless a separate writing task
explicitly authorizes a destination; never supersede another planning brief.

## Example

Input: model an intake workflow and the derived measurements it produces.
Expected: resource relationships and writer ownership grounded in R4, reuse of
local definitions, and verified or explicitly unresolved terminology. No guessed
codes, automatic profile creation, or imported generic canonical namespace.