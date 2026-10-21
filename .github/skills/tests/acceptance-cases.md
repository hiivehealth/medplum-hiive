# Customization Acceptance Status

This checklist applies only to the platform skills listed in
[the local catalog](../README.md) and the offline FHIR Reviewer. It replaces the
retiring monorepo's workspace-specific test harness; no automated customization
tests were migrated or run here.

## Current status

- Structural and link validation: pending.
- Human content and security review: pending.
- Isolated VS Code discovery, invocation, and adversarial testing: pending.
- Human activation approval: pending.
- Invocation: disabled. Keep `user-invocable: false` and
  `disable-model-invocation: true`.

## Required acceptance cases

1. Parse every frontmatter block; verify skill folder/name consistency, valid
   local links, and both disabled invocation flags.
2. Review instructions against this platform checkout's actual code, docs, and
   tests; distinguish generic R4 guidance from Hiive-specific contracts.
3. Use a synthetic-only, isolated workspace with no patient data, credentials,
   host secrets, live MCP servers, or production network access. Test each
   enabled-in-copy skill against a positive case and adversarial untrusted
   resource text.
4. Test the FHIR Reviewer separately. Its effective tools must be exactly
   built-in read/search, with no delegation, shell, network, MCP, or write
   capability. Stop if the harness expands those tools.
5. Independently review attempted calls and outputs. A static check, scenario
   rehearsal, model assertion, or successful unit test does not establish
   runtime safety or authorize activation.

Any change to a definition or referenced guidance requires re-review. Do not
enable either invocation path until every applicable gate and explicit human
approval are recorded outside these files.
