# Medplum Platform Customizations

These repo-local definitions provide bounded design/review assistance for FHIR and Medplum behavior; they do not replace platform-specific contribution guidance. Hiive resource definitions are owned by the separate `hiive-fhir-resources` repository, and general-purpose shared agents are maintained in `hiive-agents`.

## Skills

- [R4 model design](fhir-r4-data-model-design/SKILL.md)
- [Medplum access review](medplum-access-review/SKILL.md)
- [Questionnaire workflow](medplum-questionnaire-workflow/SKILL.md)
- [Offline FHIR Reviewer](../agents/fhir-reviewer.agent.md)

Read [security boundaries](references/security-boundaries.md) before using these definitions. Skills are enabled for manual invocation with `user-invocable: true` and `disable-model-invocation: true`. On 2026-10-21, the user confirmed completion of human security review and isolated runtime acceptance and approved this activation. Automatic invocation and the separate FHIR Reviewer remain disabled.
