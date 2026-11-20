---
name: orchestrating-parallel-workers
description: Use when fanning out multi-step work to parallel workers — spawning subagent or herdr workers, writing task files, or when a worker stalls, gets blocked, or its report is needed
---

# Orchestrating parallel workers

You are the orchestrator. Workers execute one task each; you keep the loop,
the context, and the decisions. Read this page fully before the first
dispatch; it exists to prevent five known failure modes:
permission stalls, stale-spec drift, scrollback-lost reports,
hook-blocked prompts, and faithful copying of task-file bugs.

## Channels: pick by who supervises

Four channels exist. Pick by who supervises and by what the worker needs.

| Channel | Properties | Use it for |
|---|---|---|
| Named Agent spawns | In-process teammates; tools stripped to Grep, Glob, Skill, SendMessage, EnterWorktree, ExitWorktree; read-only; addressable while live | Investigation breadth; follow-up questions to a live reader |
| Unnamed background Agent spawns | The agent file's full declared toolset; one-shot; not addressable after completion | The wave channel; matches the task-file contract |
| herdr panes | Persistent, watchable, permission-isolated | Coordinator pane, investigator pane, reviewer-pane escalation, watch stages |
| Workflow tool | Deterministic loop structure over read-only agents | Converge stage: brainstorm rounds plus advisor votes; loop-until-CLEAN with documented terminated rescuers. Schemas replace verdict-token prose wherever workflows run |

Rules:

- **The wave channel is unnamed background Agent spawns.** A named spawn
  arrives as a stripped, read-only teammate — it cannot write task or
  report files. Dispatch waves one subagent per task, together, no name
  parameter.
- **Only the coordinator spawns or closes panes** (the ONLY-ONE-spawner
  rule). Workers and subagents never touch herdr. The coordinator alone
  runs herdr commands.
- **Cap: 4 concurrent workers.** More tasks means more waves.
- Drive panes only through the `herdr` skill; the user keeps the focused
  pane. One agent per pane, `--no-focus`, explicit `--cwd`.
- Panes surface no frontmatter-declared MCP servers; no task step may
  assume MCP tools inside a herdr pane.

## Task-file protocol

1. In `/private/tmp/tasks/<run>/`, write one file per task:
   `<task-id>.md`, numbered from `01`.
2. Each file carries a `version:` line at the top and these sections:
   `## Goal`, `## Steps`, `## Out of bounds`, `## Verification`,
   `## Report path`.
3. **Independence check before writing**: two tasks are parallel-safe only
   if neither reads nor writes a file the other touches. Sequential
   dependencies go in one task, in order.
4. Task files live in `/private/tmp/tasks/<run>/` — never in a worktree or repo,
   so no governance hook or git status ever sees them.
5. Keep task IDs stable; workers name their reports after them.
6. Write every task and report file atomically: write `<path>.tmp` first, then `mv <path>.tmp <path>`. A report file that lacks its verdict token counts as BLOCKED.
7. Wave task files prohibit downward fan-out: a worker that attempts the Agent tool appends `BLOCKED: needed downward fan-out because the task file forbids it` and stops — unless the task file explicitly grants fan-out for that task.

## Bootstrap smoke test

Before wave 1, dispatch one trivial worker: run `git status` in the
worktree and edit one file under `/private/tmp/tasks/<run>/` (the smoke
report). Gate wave 1 on the smoke report file being present with a
`done` result. A failed smoke run is a stop-and-diagnose event, not a
wave delay.

## Post-flight: advisor reviews the implementation

After collection, give the `advisor-on-bedrock:advisor` agent the worker
report files plus the one-line goal of the fan-out. This is the cheapest
place to catch a bug that five workers copied faithfully. Fold accepted
points into the work; surface disagreements to the user.

## Dispatch

- Prompt per worker is **one line**: `Read /private/tmp/tasks/<run>/<task-id>.md
  and execute it. Your report path is in the file.` No task content goes
  inline — hooks and stale-copy risks live in prompt text. (The worker
  profile instructs `cat`-fallback when `read` is denied; it observed this
  in testing, so the prompt stays one line either way.)
- After dispatch, verify each worker produced a report file; a missing
  report after its work window is the fail-loud signal to investigate.

## Coordinator verifies the work

You are the evidence authority. When a worker's report claims done:

1. Run `git -C <worktree> diff` yourself and read the diff the report names.
2. Re-run the test commands the report names.
3. Workers' test output is a claim until you reproduce it.

## Pane lifecycle

For stages that run in a pane, the coordinator owns the full cycle. All
herdr names take the run id as prefix (`t<last4>-<slug>-<shorthash>-<role>`;
`<shorthash>` is `git -C <worktree> rev-parse --short=7 HEAD`. Herdr names
must start with a letter. Keep the slug to 5 characters or fewer so the
longest name stays within herdr's 32-character cap. Use `-w1` style suffixes
for workers). Resolve a pane by agent name while it is live; after a herdr
restart, resolve by the `claude_session_id` stored in the run registry and
re-adopt with `claude --resume`.

1. Split: `herdr pane split --current --direction right --cwd "$PWD" --no-focus`; read `pane_id` from the response.
2. Start: `herdr agent start <run>-<role> --kind claude --pane <pane_id> -- --agent <role-file-name> --settings '{"permissions":{"deny":["Bash(git commit:*)","Bash(git push:*)","Bash(gh:*)","Bash(herdr:*)"],"defaultMode":"acceptEdits"}}'` for worker and investigator panes. Drop `--settings` only for genuinely read-only panes — explore and reviewer-subagent lanes. The investigator has Write, Agent, and Bash, so its pane gets the same deny blob as workers.
3. Record name, `pane_id`, `claude_session_id`, and `transcript_path` in the run registry (`~/.claude/herdr-runs/<run>/state.md`).
4. Prompt: `herdr agent prompt <name> "<one line>" --wait --timeout 120000`.
5. Settle is not done. After `--wait` returns, poll for the report file; parse the verdict token from the file, never from pane output.
6. Close: `herdr pane close <pane_id>`. Never close a pane you did not create.

## Correcting a running worker

1. Edit the task file — never send corrections as prompt text.
2. Bump its `version:` line.
3. Background subagent: if it has not finished, note the pending
   correction and re-dispatch a fresh worker after it returns; a running
   subagent cannot re-read mid-flight. Herdr pane: send one line —
   `Your task file changed (version bumped). Re-read it and continue.`
   If drift is severe, wait for completion and respawn on the new version.

## Collecting and closing

1. Read every report **file** — never trust pane scrollback for content.
2. Ensure every `BLOCKED` line became a visible decision for the user.
   A worker pane's final reply usually ends with a self-reported `BLOCKED:` line — the global Stop hook demands an advisor dispatch; in wave tasks the task-file rule forbids spawning, so the pane reports that demand as BLOCKED. A pane that dispatches the advisor successfully, or a task file that grants fan-out, may not produce the line. The coordinator ignores that specific BLOCKED as expected noise. Only `BLOCKED:` lines inside a report file are decisions.
3. Send the combined diff to the `code-reviewer` subagent before reporting
   completion.
4. Report results to the user with the report paths, per-task status, and
   the combined BLOCKED list.

## When to reconsider an orchestrator agent

Kill this skill's approach and escalate only when polling noise in this
session measurably degrades the task, or fan-outs regularly exceed five
workers. Then design a **primary-mode** orchestrator with `edit: deny`
outside task paths — never a subagent; it cannot reach the user when a
worker blocks.
