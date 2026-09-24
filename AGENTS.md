# Project instructions

Before working, read `.codex/AGENTS.md`. Apply more specific repository
instructions where relevant and honor the user's current scope.

For implementation tasks that modify application code, the main agent must
assign the bounded implementation to `luna_coder`, then audit the actual diff
and verification results. Use `.codex/agents/luna_coder.toml`, model
`gpt-6-luna`, reasoning effort `high`, with fresh context when supported.
If this model or delegation is unavailable, report the limitation; do not
silently substitute another model. Continue useful read-only diagnosis.

These delegation requirements apply to the main agent only. A delegated coder
implements its assigned task without spawning additional agents. Questions,
analysis, reviews, documentation and configuration-only skill maintenance may
be handled directly. Do not fan out routine tasks to multiple agents.

## Default agent workflow: Superpowers + Ponytail

For software tasks, use the Superpowers `using-superpowers` skill as the
workflow entry point and Ponytail as the implementation-scope/YAGNI guide when
they are available in the current Codex session. Apply the repository adapter
in `docs/codex/SUPERPOWERS.md`; it preserves the delegation and verification
rules above. If either plugin is unavailable, do not claim it was used; follow
the adapter's fallback and report that native plugin guidance is unavailable.
