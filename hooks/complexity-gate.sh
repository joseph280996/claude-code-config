#!/usr/bin/env bash
# Complexity gate: block over-complex prompts before inference.
# UserPromptSubmit hook input JSON arrives on stdin. Keep this fast (no model calls).
set -euo pipefail

input=$(cat)
prompt=$(printf '%s' "$input" | jq -r '.prompt // empty' 2>/dev/null || true)
[ -z "$prompt" ] && exit 0

# Already escalated? Never gate a session on an Opus variant.
model=$(printf '%s' "$input" | jq -r '.model // .modelInfo.id // empty' 2>/dev/null || true)
if [ -z "$model" ]; then
  tpath=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null || true)
  if [ -n "$tpath" ] && [ -f "$tpath" ]; then
    model=$(tail -c 200000 "$tpath" 2>/dev/null | jq -r 'select(.message.model != null) | .message.model' 2>/dev/null | tail -1 || true)
  fi
fi
if printf '%s' "$model" | grep -qiE 'opus'; then
  exit 0
fi

# Subagent escalation marker: surface it; do not block the report.
if printf '%s' "$prompt" | grep -q 'ESCALATE: Tier 1'; then
  jq -n '{hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:"The subagent reported ESCALATE: Tier 1. Tell the user: run /model opus, then redo the task as the escalated (Opus) run."}}'
  exit 0
fi

# Prompt-level complexity score. Cheap heuristics only.
score=0
printf '%s' "$prompt" | grep -qiE 'architect|migrat(e|ion)|redesign|rewrite|refactor (the|all|entire|whole)|multi-(service|repo|tenant|step)|across (services|repos)|schema change|breaking change|security|authentication|authorization|zero.?downtime' && score=$((score+2))
printf '%s' "$prompt" | grep -qiE 'design doc|trade.?offs|two (approaches|options)|multiple (approaches|designs)|irreversible|risky' && score=$((score+1))
words=$(printf '%s' "$prompt" | wc -w | tr -d ' ')
[ "$words" -ge 120 ] && score=$((score+1))
verb_hits=$(printf '%s' "$prompt" | grep -oiE 'implement|design|migrate|refactor|rebuild|integrate|plan' | wc -l | tr -d ' ' || true)
[ "$verb_hits" -ge 3 ] && score=$((score+1))

if [ "$score" -ge 2 ]; then
  reason="Complexity gate (prompt score $score): this looks like multi-file or architectural work. Run /model opus and resubmit, or dispatch this to planner (settled requirements) or advisor-on-bedrock (second opinion)."
  jq -n --arg r "$reason" '{decision:"block", reason:$r}'
  exit 0
fi
exit 0
