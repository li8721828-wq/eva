# Eva Project Agent Rules

These instructions apply to the entire repository.

## Project memory is mandatory

This repository has its own engineering memory. It is separate from Eva's runtime user/project long-term-memory feature.

Before changing code, read:

1. `PROJECT_MEMORY.md`
2. `docs/project-memory/ARCHITECTURE.md`
3. `docs/project-memory/REGRESSION-GUARDS.md`
4. The newest entries in `docs/project-memory/CHANGELOG.md`

After a change:

- Append the change, affected files, verification, and remaining risk to `docs/project-memory/CHANGELOG.md`.
- Update `REGRESSION-GUARDS.md` when a new invariant or failure mode is discovered.
- Keep project-memory notes factual and concise. Do not store user secrets, raw prompts, or complete model transcripts.

## Change discipline

- Read the existing implementation and nearby tests before editing.
- Preserve behavior that is explicitly listed as a regression guard.
- Keep renderer layout state separate from persisted conversation data.
- Do not represent simulated model reasoning as real execution evidence.
- Run the narrowest relevant tests first, then `npm run typecheck`; run the full suite for shared runtime or renderer changes.
