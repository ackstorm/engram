# CLAUDE.md

Engram — universal memory layer for AI agents (SQLite + sqlite-vec).

## References

Detailed design/constraint docs live in `./docs/references`, indexed here:

- [Embedding config is immutable per vault](docs/references/embedding-config-is-immutable.md) — permanent architectural constraint of the SQLite/sqlite-vec design.
- [Memory scope and types — design](docs/references/memory-scope-and-types.md) — the project/global vault split, the `profile` memory type, and the repair path for mis-targeted writes. Implemented across Plans 1-3; see `docs/superpowers/plans/`.
