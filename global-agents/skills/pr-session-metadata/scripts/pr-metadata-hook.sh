#!/bin/bash
# PostToolUse hook: auto-append session metadata to PRs created via gh pr create
# Reads hook input from stdin (JSON with tool_input and tool_output)

INPUT=$(cat)

BASH_CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_output.stdout // empty')

# Only act on gh pr create commands that succeeded
if ! echo "$BASH_CMD" | grep -qE '\bgh\s+pr\s+create\b'; then
    echo '{"continue":true}'
    exit 0
fi

# Extract PR URL from gh pr create output (last line is typically the URL)
PR_URL=$(echo "$TOOL_OUTPUT" | grep -oE 'https://[^ ]+/pull/[0-9]+' | tail -1)

if [ -z "$PR_URL" ]; then
    echo '{"continue":true}'
    exit 0
fi

# Generate session metadata markdown
METADATA=$(python3 ~/.claude/scripts/session-metadata.py 2>/dev/null)

if [ -z "$METADATA" ]; then
    echo '{"continue":true}'
    exit 0
fi

# Get current PR body
PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')
REPO_SLUG=$(echo "$PR_URL" | sed -E 's|https://[^/]+/([^/]+/[^/]+)/pull/[0-9]+|\1|')
CURRENT_BODY=$(gh pr view "$PR_NUMBER" --repo "$REPO_SLUG" --json body -q .body 2>/dev/null)

if [ $? -ne 0 ]; then
    echo '{"continue":true}'
    exit 0
fi

# Append metadata to body
NEW_BODY="${CURRENT_BODY}

---

${METADATA}"

# Update the PR
gh pr edit "$PR_NUMBER" --repo "$REPO_SLUG" --body "$NEW_BODY" >/dev/null 2>&1

if [ $? -eq 0 ]; then
    echo "{\"continue\":true,\"systemMessage\":\"📊 Session metadata auto-appended to PR ${PR_URL}\"}"
else
    echo "{\"continue\":true,\"systemMessage\":\"⚠️ Failed to append session metadata to PR\"}"
fi
