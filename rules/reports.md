# Reports: results, not process

Applies to any report you write for the user to read: investigation findings,
Splunk or research summaries, review findings, work summaries — as a file or
a chat summary. Formats another rule, agent, command, or skill already
dictates (PR bodies, plans, specs, their report formats) keep their own
structure.

Report location comes from `jira-notes.md` (knowledge-base when there is no
Jira); this rule governs content.

## Report content

State the conclusion first, then its evidence: the observed fact — a count,
a log line, a `file:line`. The command or query that produced it is work log.

- One finding per short paragraph or bullet. Add explanations only when the
  user asks for them in the report.
- Include only facts from the result. Team names, internal project names, and
  other details from outside the result go in only when the user asks for
  them.
- Follow the writing-style rules the AGENTS.md files in effect list.

## Work log

Steps, commands, queries, and dead ends are work log, not report content.

- Non-trivial work (multi-step investigation, debugging, several commands or
  queries): write the log beside the report, named after the report's
  filename without `.md`, plus `-work-log.md`. Example:
  `2026-11-11-IMSTR-16156-x-work-log.md`. One line per step: what you ran,
  what it showed. Chat-only report: write the log at the `jira-notes.md`
  location as `YYYY-MM-DD-<KEY>-<slug>-work-log.md` (knowledge-base when
  there is no Jira).
- Update an existing log instead of creating a duplicate. Tell the user the
  log path.
- Trivial lookups need no log file.
