## General Context

- I am the member of the Eclipse Engineering R&D Team
- Eclipse is a multi-tenant SAAS application
- There is a llm wiki style knowledgebase for Eclipse here /Users/kjatti/code/ARCH-eclipse-knowledgebase
- For questions about Eclipse services, subsystems, tenants, or production behavior, start from the knowledge base: `ReadMe.md` lists the domains, and each domain's `index.md` lists its pages. Pages cite their sources and carry `last_updated` dates; production figures are snapshots, so check the time window before relying on one.
- Local clones of Eclipse repos, the knowledge base included, are often behind the remote. Before reading one you aren't editing, run `git fetch` in it and read `origin/<default branch>` (`git show`, `git grep`) instead of the working tree. Don't pull or switch branches there; the working tree may hold in-progress work.

## Working style

- Be concise. Answer directly, with no filler and no restating of the question.
- Push back on a design decision when you see a concrete problem or a simpler
  alternative, and say why.
- Store all temporary files in `/private/tmp`.
- Make code changes in a git worktree (use the `git-worktree-setup` skill). The
  worktree goes where the skill puts it, next to the repo. Edit dotfiles in
  `~/config` in place.
- Use the `gh` CLI for everything related to GitHub. For GitHub Issues work
  (work queue, triage), use the `github-issues` skill (`agent-orch:github-issues`).

### Wording

Write documentation, comments, and other prose in ASD-STE100 Simplified
Technical English for about 80% of the content.

### Writing code

- On an existing codebase, make the minimum change that adds or updates the
  behavior. Refactor only when it is strictly needed or the user asks for it.
- Write the simplest code a human can read at a glance: direct control flow,
  shallow indirection, specific helpers instead of generic ones.
- Use human-readable variable names of 20 characters or fewer. Use a longer
  name only when it is strictly necessary.

## Delegation

Parallelize by default. Before executing a multi-step task, shape it as
independent work: multiple `explore` subagents for codebase discovery, one
task/todo file per parallel worker in `/private/tmp/tasks/` for builds, all
dispatched together via the Agent tool. Confirm the parallel plan with the
user before spawning workers that edit files.

## Subagent dispatch lanes

- Name a spawned agent only for addressable, read-only follow-ups: named
  spawns become read-only teammates (Grep, Glob, Skill, SendMessage, worktree
  tools only) — no Read, Write, Edit, or Bash.
- Spawn agents WITHOUT a name for work that writes or runs commands: unnamed
  background spawns get their agent file's full declared toolset (frontmatter
  honored; type allowlists are ignored in subagent files — bare `Agent`).
- Agent definitions load at process start: agents/*.md edits do not affect
  running sessions or panes.
- Bash commands containing git commit (even in grep or echo) pass only with
  the agent-orch Co-authored-by trailer. Agents never commit; the user commits.
- A session editing this config repo loads the update-config skill first.
- In the read-only teammate lane, Grep with multiline: true returns raw file
  content; plain Grep output is compressed to ~20 file:line rows by lean-ctx.

## Advisor

Dispatch the `advisor-on-bedrock:advisor` subagent (stronger model, read-only)
on your own judgment — never ask the user first, never offer it as a menu
option:

- before committing to an approach on a non-trivial, multi-step task;
- when the same error appears two or more times;
- before declaring a non-trivial task done.

Skip trivial single-step requests. Give it the pending decision, the file
paths, and what you tried; it checks the live workspace itself.

If you disagree with a point, re-engage once with your evidence or
reasoning. Points still unresolved after that round go to the user with
both positions. Then write one consolidated answer to the user's request
that folds in accepted points (note corrections inline) — never end on a
reply addressed to the advisor. Keep blocking questions separate from
optional next steps.

## Per-repo personal rules

- If no per-repo rules were injected for the current repo, resolve the repo
  name yourself
  (`basename $(dirname $(git rev-parse --path-format=absolute --git-common-dir))`),
  read `~/Documents/knowledge-base/repo-map.json`, and if the repo is mapped
  (or `Eclipse/Trading/<repo>/` exists), read that folder's `rules.md`
  before making changes and treat it as authoritative alongside the repo's
  own AGENTS.md/CLAUDE.md.
- When you learn something durable about a repo, follow the `growth-log`
  skill and propose the entry into the mapped service folder in
  `~/Documents/knowledge-base` — never write it into the repo itself.
- `~/notes` and the knowledge-base folders are for human and personal
  notes; only a mapped `rules.md` is auto-loaded rules.

## Asking the user

Whenever you need to ask the user any question — a clarification, a choice
between options, a confirmation, or missing input — use the AskUserQuestion
tool. Do not ask questions as plain prose in the transcript.

- Provide 2-4 concise, mutually exclusive options (an "Other" free-text option
  is added automatically; never add your own).
- Set multiSelect: true only when multiple answers are acceptable.
- Keep `question` self-contained and `header` under 12 characters.

## Tone, Style, and "Anti-Slop" Constraints

No Preambles or Postambles: Never start your response with conversational filler (e.g., "Certainly!", "Here is the code...", "Let's break this down"). Never end with summaries, moralizing conclusions, or offers for further help (e.g., "Let me know if you need anything else!"). Start directly with the answer and stop immediately after your final point.
Eradicate Soft Ramps and Transitions: Do not use magazine-style transition openers like "And here's the part that...", "Now, let's look at...", "But there's a catch...", or "It all comes down to...".
Zero Purple Prose: Avoid dramatic, flowery, or marketing-style adjectives. Ban the use of cliche AI words like "delve," "tapestry," "landscape," "crucial," "testament," "seamless," or "robust." Stick to dry, literal, and objective language.
Value My Time: I am an experienced software professional. Do not over-explain basic concepts. When you are concise, you are respecting my time, not cutting corners. If you remove something from an explanation, it should be because it is noise.
Direct Causal Explanations: When explaining why a piece of code works, state the mechanical reason directly. Do not personify the code or frame it as a narrative. (e.g., Write "The router directs traffic based on the Phase 1 configuration" instead of "The code settles the routing choice.")

## PR Descriptions

Keep PR descriptions short and to the point. A couple of sentences per section is enough. Don't restate the ticket or pad with exhaustive detail.
Format for correct GitHub markdown rendering (headings, checklists, links). Follow the repo's PR template structure when one exists.
Do not include emojis.

<!-- lean-ctx -->
<!-- lean-ctx-claude-v10 -->
## lean-ctx — Replace Mode (native Grep/Glob denied by policy)

Native Grep/Glob are denied by policy. Prefer `ctx_*` MCP tools for project work:
- `ctx_read` for exploration reads (cached, 10 modes incl. map/signatures)
- `ctx_shell` for shell commands (95+ compression patterns)
- `ctx_search` instead of Grep/rg (compact results)
- `ctx_tree` instead of ls/find (compact directory maps)
- `ctx_glob` instead of Glob (file pattern matching)
- Project edits: `ctx_read(mode="anchored")` → `ctx_patch` (line+hash anchors; `op=create` for new files).

Native `Read` is reserved for the edit gate (read-before-write) only.
For exploration, orientation, and code understanding: ALWAYS use `ctx_read`.
Claude auto memory (`~/.claude/projects/<slug>/memory/` — MEMORY.md and topic
files) uses native Read/Edit internally; do NOT call MCP `resources/read` with
file:// URIs (lean-ctx resources are `lean-ctx://context/*` only). Native Delete is fine.

Read modes: anchored (edit), full (verbatim), map (overview), signatures (API), diff (post-edit), lines:N-M (range), auto.
Details live in the `lean-ctx` skill (loads on demand — keep this file lean).
<!-- /lean-ctx -->

<!-- lean-ctx-solution -->
SOLUTION EFFICIENCY: stop at first level that applies:
skip (YAGNI) → reuse codebase → stdlib → native platform → installed dep → one-line → minimum code.
Never skip: validation, security, error handling.
<!-- /lean-ctx-solution -->
