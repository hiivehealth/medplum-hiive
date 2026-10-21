---
description: "Use when authoring FSH, generated FHIR R4 resources, terminology, questionnaires, AccessPolicies, environment manifests, or upload tooling in the Hiive FHIR workspace."
---
# FHIR Resource Changes

- Keep `fhirVersion` exactly `4.0.1` (R4) in sushi-config.yaml in the hiive-fhir-resources repository. Use R4 definitions when checking resource types, elements, and datatypes; reject R4B/R5-only or newer constructs and core packages. Any version migration requires explicit approval.
- Follow the package authoring and upload workflow in the hiive-fhir-resources repository; preserve its shared/tenant organization and canonical URLs when moving source files.
- Treat FSH as authoritative. Do not hand-edit compiled resources to implement a change. Compile before testing generated snapshots and review source and generated artifacts together.
- Reuse neighboring tests under tests/ in the hiive-fhir-resources repository. Profile tests inspect compiled snapshots; policy helper/FHIRPath tests do not prove live server authorization. Do not claim server enforcement from a passing unit test.
- For terminology changes, consult terminology stewardship in the hiive-fhir-resources repository before introducing or importing code systems and value sets.
- Environment manifests govern deployment membership and Project settings. Review affected manifests when adding or renaming resources; inspect the target dry-run Bundle before requesting a live upload. A live upload can also mutate Project settings.
- Use the package's build, typecheck, and test scripts for this slice, then the root validation gate before review. Follow [root security and publishing rules](../../AGENTS.md#security-and-publishing); never authenticate or upload without explicit authorization.