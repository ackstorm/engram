---
name: engram-memory
description: Use when storing or recalling long-term memory with Engram — choosing between project and global scope, picking a memory type, or resolving conflicting remembered rules.
---

# Engram memory

Two stores, like CLAUDE.md: `./CLAUDE.md` is the project, `~/.claude/CLAUDE.md` is you.

## Choosing scope — required on every write

**global** — true regardless of which codebase you are in:
preferences and traits, personal habits, personal history, company-wide rules.

**project** — specific to this repository:
its conventions, its architecture, its incidents, its deploy process.

When unsure, choose **project**. A memory filed too narrowly is merely invisible
elsewhere; one filed too broadly is noise in every project, forever.

## Choosing type

| Type | Holds | Example |
|---|---|---|
| `episodic` | something that happened, at a time | "the deploy failed Tuesday on cert renewal" |
| `semantic` | a fact that is simply true | "this repo uses pnpm, not npm" |
| `procedural` | how to do something | "cut a release with pnpm release" |
| `profile` | a stable trait of the user | "prefers TypeScript, wants concise answers" |

Type and scope are independent. A personal *event* is `episodic` + `global`.

## Recall

`engram_recall` reads both stores and labels every hit `[scope · type]`. Omit
`scope` unless you deliberately want one store.

**Project beats global when they conflict.** If a global memory says "write
commit messages in the imperative" and a project memory says "prefix commits
with the ticket ID", follow both where compatible and prefer the project rule
where not.

## Fixing mistakes

Stored something in the wrong place? `engram_move({ id, scope })`. Its
connections to other memories are dropped — edges cannot span stores.
