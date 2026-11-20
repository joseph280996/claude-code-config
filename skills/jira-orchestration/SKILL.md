---
name: Jira Orchestration
description: "Run the gated Jira delivery pipeline on a ticket: analysis, parallel investigation, plan, brainstorm review loop, Plannotator approval, parallel task execution, code review."
---

Run the full delivery pipeline on one Jira ticket. Three phases, each with a
gate. Gates are binding: you stop, the user decides, then you continue.

## Run state

At the first dispatch, create the run. Run id: `t<last4>-<slug>-<shorthash>`
(`<shorthash>` is `git -C <worktree> rev-parse --short=7 HEAD`). Herdr names
must start with a letter. Keep the slug to 5 characters or fewer so the
longest name stays within herdr's 32-character cap.

- `~/.claude/herdr-runs/<run>/state.md` — durable registry. One file per
  run: `{phase, round, wave, pane table (name, pane_id, claude_session_id,
  transcript_path), verdicts}`.
- `/private/tmp/tasks/<run>/` — task and report files. `/private/tmp` is
  reboot-volatile; the registry is not.

Update `state.md` at every stage transition and before every gate. Resolve
a herdr pane by agent name while it is live (`herdr agent get <name>`);
after a restart, pane ids renumber and names clear, so resolve by the
`claude_session_id` in the pane table and re-adopt with `claude --resume`.
Register every parsed verdict token in the registry.

## Phase 1 — Understand

1. **Fetch the ticket.** Use the `mcp-atlassian` MCP tools to get the issue.
   Extract: summary, description, acceptance criteria, priority, labels,
   linked issues, comments. If credentials are missing, stop and tell the
   user to set them up.

2. **Set up the worktree.** Run the `git-worktree-setup` skill. Suggest a
   branch name derived from the ticket — `trad/<last4>-<slug>`, where
   `<last4>` is the last four digits of the issue number and `<slug>` is a
   short kebab-case topic from the summary. The skill asks which base to use
   and confirms before creating; never guess the base.

3. **Investigate.** Launch one investigator pane yourself — split the pane
   as in the `herdr` skill, read `pane_id`, then:
   `herdr agent start <run>-inv --kind claude --pane <pane_id> -- --agent investigator`
   The investigator pane receives the same deny blob as worker panes
   (Bash(git commit:*), Bash(git push:*), gh, and herdr denied) since it
   has Write, Agent, and Bash. The investigator pane runs the breadth leg itself with unnamed in-pane
   subagent fan-out for codebase surfaces, plus named teammates for
   follow-up questions; its Write and Agent tools are scoped in
   `agents/investigator.md`. Give it the exact Splunk or Grafana queries.
   The pane surfaces no MCP servers; the grafana curl fallback lives in
   the investigator body. Read-only facts are the pane's to find; do not
   ask the user for anything discoverable.

4. **Gate: present findings.** Give the user the ticket analysis plus the
   merged investigation findings, and stop. Present the gate with the AskUserQuestion tool, in this pane, with 2-4 options; the user answers in the TUI. They steer before planning.

## Phase 2 — Plan

1. **Settle requirements.** Interview the user until the design has no
   unsettled decisions (one round at a time; look up facts yourself first —
   dispatch `explore` or `investigator` for anything discoverable).

2. **Dispatch the planner.**

   **Pre-score the dispatch.** Score the 12 conditions and the tier rules in
   `agents/planner.md` § Model escalation against the ticket analysis and
   the investigation findings. Score #8 only if the settled requirements
   already show the plan's size — before a plan exists it cannot be scored.
   Tier 1 → dispatch the planner directly with
   `model: SSC-US/us.anthropic.claude-opus-5-5-1m#high`. For a pre-scored
   dispatch, send only the statement that this dispatch is the escalated run
   and must not emit `ESCALATE:` again — there is no prior Complexity line and
   no draft to revise. No user confirmation needed, the pre-score decides. Tier 0 → dispatch on the default model. The
   `ESCALATE:` marker stays as the safety net for default-model dispatches
   the pre-score misses.

   One `planner` subagent dispatch containing:
   the ticket analysis (key, summary, acceptance criteria), the settled
   requirements, the investigation findings worth carrying into the plan,
   and the plan-file path —
   `~/notes/TRAD/Jiras/<last4>/plans/YYYY-MM-DD-<FULL-KEY>-<slug>.md`,
   per `rules/jira-notes.md`. The planner writes the plan; it never
   interviews the user. If it reports `BLOCKED:`, bring the unsettled point
   back to the user, settle it, and re-dispatch. If it reports
   `ESCALATE: Tier 1`, stop before the brainstorm loop: tell the user the
   plan needs the Opus model for planning and get their call on switching
   (`SSC-US/us.anthropic.claude-opus-5-5-1m`) or continuing. On confirm,
   make a fresh `planner` dispatch (no sessionID — the model override applies
   at dispatch time) with
   `model: SSC-US/us.anthropic.claude-opus-5-5-1m#high`, carrying the original dispatch
   prompt plus the first run's Complexity line, plan-file path, and a clear
   statement that this dispatch is the escalated run and must not emit
   `ESCALATE:` again. Keep the original `ESCALATE:` marker out of the
   prompt — quoting it back can read as an instruction to escalate. This
   way Opus revises the draft rather than restarting, and one escalation
   cannot loop. A declined switch continues the pipeline on
   the GLM draft as-is. Once a ticket is escalated — by pre-score or by the `ESCALATE:` marker —
   every later `planner` dispatch for it (a `BLOCKED:` re-dispatch, or requirements
   changed after review) keeps the same `model:` override and the
   escalated-run statement — the ticket stays on Opus.

3. **Brainstorm review loop.** Repeat until convergence, capped at 3 rounds per check-in:
   a. Dispatch the `brainstorm` subagent with the plan file and the ticket
      context. Ask it to attack the plan: wrong assumptions,
      missing edge cases, simpler alternatives, risks. End the report with
      one line: VERDICT: CLEAN or VERDICT: ISSUES <n>. Brainstorm reports
      its findings; the orchestrator alone edits the plan file.
   b. Fold every accepted point back into the plan.
   c. Report the round number and what changed to the user.
   d. Points still unresolved after you re-engage once with your evidence go
      to the user — not back to brainstorm.
   Parse the round verdict from the brainstorm report: `VERDICT: CLEAN` ends the loop; `VERDICT: ISSUES <n>` means the next round. After 3 rounds without `VERDICT: CLEAN`, take the open points to the user with both positions instead of a round 4.

4. **Advisor review of the plan.** Dispatch the `advisor-on-bedrock:advisor`
   agent with the plan-file path — this runs once, after planner and
   brainstorm have both finished. Fold accepted points into the plan the
   same way as brainstorm round points.

5. **Gate: Plannotator.** Submit the plan for review with the `submit_plan`
   tool. Approval is the only thing that starts Phase 3. After submit_plan returns, treat the Plannotator approval as the Phase 3 gate — do not add a second AskUserQuestion here. If the review
   requests changes, fix and resubmit from step 3 (edit the plan yourself —
   do not re-dispatch the planner unless requirements changed).

## Phase 3 — Execute

1. **Invoke the `orchestrating-parallel-workers` skill** and follow it in
   full — it owns the task-file protocol, the independence check, the
   4-worker cap, dispatch, collection, and the post-implementation advisor
   review.

2. **Decompose.** Split the plan into parallel-safe tasks: two tasks are
   parallel-safe only if neither reads nor writes a file the other touches;
   sequential dependencies go in one task, in order. Number task files from
   `01`; each carries a `version:` line, `## Goal`, `## Steps` (checkbox
   list), `## Out of bounds`, `## Verification`, `## Report path`. Task
   files live in `/private/tmp/tasks/<run>/` — never in a worktree or repo, and
   they are read-only to workers. Each wave task file states the fan-out rule: no downward fan-out unless the task grants it; a worker that attempts it reports `BLOCKED: needed downward fan-out because the task file forbids it`.

3. **Gate: confirm dispatch.** Show the user the checklist and stop. Present the gate with the AskUserQuestion tool, in this pane, with 2-4 options; the user answers in the TUI. Dispatch
   only on their go.

4. **Dispatch.** Unnamed background Agent spawns — no name parameter, one
   per task, dispatched together (named spawns arrive as stripped,
   read-only teammates). Prompt per worker stays exactly one line:
   `Read /private/tmp/tasks/<run>/<task-id>.md and execute it. Your report path is in the file.`
   Task files live in `/private/tmp/tasks/<run>/`. Use a specialist agent
   instead of `worker` only when a task clearly fits one — the seven
   agents in `agents/orchestrator.md` are the allowed set. For pane stages,
   follow the pane lifecycle in `orchestrating-parallel-workers`. The
   fan-out rule in each task file governs worker Agent use.

5. **Collect.** Read every report file, never scrollback. A missing report
   is the fail-loud signal. After a pane stage settles, poll for its report file every 15 seconds until the file appears or the task timeout expires; then parse the verdict token from the file. A report whose verdict token is missing counts as BLOCKED. Register pane and worker verdicts in `state.md`. Every `BLOCKED:` line becomes a visible decision
   for the user.

6. **Advisor review of the implementation.** Give the
   `advisor-on-bedrock:advisor` agent the report files and the combined
   diff — this runs once, after the workers finish. Fold accepted points
   in; surface disagreements to the user.

7. **Review.** Send the combined diff to the `code-reviewer` subagent before
   reporting completion. The review runs as a Workflow call whose reviewer schema carries `needs_execution_evidence`: when it is true, escalate to a reviewer pane for execution verification instead of trusting the diff claim. Loop the review at most 2 rounds; parse `APPROVE` or `BLOCK` from the reviewer verdict each round, and register it. After a second `BLOCK`, stop and hand both positions to the user at a gate.

8. **Report.** Print per-task status, report paths, the combined BLOCKED
   list, and a diff summary. Do not commit, push, open a PR, or transition
   the Jira ticket — the user does that.
