# 3. Agents read and write tickets only through `orchi tickets`

Accepted, 2026-11-03.

## Context

The orchestration skills told agents to use Linear's own tools, to open an issue on one team for every pull request,
and to move tickets on every run. That fit one person's work. Orchi reads tickets from several sources, and the user
picks which.

## Decision

- `orchi tickets` is the only way a skill reads or writes a ticket. No skill names a source's own tool.
- An orchestrator writes to Linear only when `sources` in Orchi's settings includes `linear` and the user allowed
  Linear writes for that run, in its start prompt, run rules or plan. A run that says "No Linear writes" makes none.
- Without both, the tracker log and the pull requests are the record, and `/wrap` moves the tickets the session names.
- The switchboard writes a ticket only when the user's current message asks for it.
- A ticket reference never goes in a pull request, commit or doc on a repo whose owner is not in
  `github.own_owners`.

## Consequences

- A user without Linear gets no Linear steps, and a run with Linear makes no writes it wasn't given.
- There is no settings key that turns writes on for every run. Each run says so, because a write is outward-facing.
