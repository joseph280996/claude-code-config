---
name: pr-session-metadata
description: >
  Use when creating a PR or before finishing a branch — parses the current Claude Code
  session transcript to calculate what percentage of work used Skills, Agents, Plan Mode,
  or Direct Prompting, and generates a metadata section for the PR description.
license: Proprietary
---

# PR Session Metadata

Analyzes your Claude Code session and generates a breakdown of **how** the work was done — what % was direct prompting, skill-driven, agent-driven, or plan-driven — for inclusion in PR descriptions.

## What It Tracks

| Category | What it means |
|----------|--------------|
| **Direct Prompting** | User typed a prompt, Claude executed with Read/Edit/Bash |
| **Skill-Driven** | A skill was invoked (e.g. `qa-automation-standards`) — includes follow-up implementation turns |
| **Agent-Driven** | Sub-agents were dispatched — includes what each agent did |
| **Plan Mode** | Claude entered plan mode for design/architecture |
| **MCP Integrations** | External tools like Jira, Confluence were used |

## How It Works

Uses **segment-based categorization**: all assistant turns between two real user prompts form a "segment". Tool-result entries (logged as `type: "user"` in the transcript but containing only `tool_result` content) are skipped when finding segment boundaries, so a Skill invocation followed by Read → Edit → Bash all count as one skill-driven segment. Slash commands typed by the user (e.g. `/wt-behave-triage`) are detected via `<command-name>` tags and counted as skill invocations.

**Priority**: Skill (including slash commands) > Agent > Plan > MCP > Direct

## Usage

### Option 1: Manual invocation (no setup needed)

Invoke `/pr-session-metadata` before creating your PR. Then run this via Bash:

```bash
python3 <path-to-this-skill>/scripts/session-metadata.py
```

Claude will include the output in the PR body.

### Option 2: Automatic via PostToolUse hook (recommended)

One-time setup — add the parser script and hook to your local machine, then configure the hook in your Claude Code settings.

**Step 1: Install the scripts**

```bash
mkdir -p ~/.claude/scripts
cp <path-to-this-skill>/scripts/session-metadata.py ~/.claude/scripts/
cp <path-to-this-skill>/scripts/pr-metadata-hook.sh ~/.claude/scripts/
chmod +x ~/.claude/scripts/session-metadata.py ~/.claude/scripts/pr-metadata-hook.sh
```

**Step 2: Add the PostToolUse hook to `~/.claude/settings.json`**

In the `hooks.PostToolUse` array, add (or merge into your existing Bash matcher):

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "~/.claude/scripts/pr-metadata-hook.sh",
      "statusMessage": "Appending session metadata to PR..."
    }
  ]
}
```

If you already have a `PostToolUse` entry with `"matcher": "Bash"`, add the hook object to the existing `hooks` array.

After setup, every `gh pr create` will automatically append the session metadata to the PR description. No manual invocation needed.

## Example Output

```markdown
## 🤖 Session Metadata

| Category | Segments | % of Session |
|----------|--------:|-----------:|
| 💬 Direct Prompting | 5 | 42% |
| 🧩 Skill-Driven | 4 | 33% |
| 🤖 Agent-Driven | 2 | 17% |
| 📋 Plan Mode | 1 | 8% |
| **Total** | **12** | **100%** |

<details>
<summary>Details</summary>

- **Skills invoked**: qa-automation-standards, genesis-pm-ui-framework
- **Agents dispatched** (2): Explore Pages architecture, Find data structures
- **Plan mode**: Yes
- **MCP integrations**: None

</details>
```

## Step-by-Step Execution (for Claude)

When this skill is invoked:

### Step 1: Run the parser

```bash
python3 ~/.claude/scripts/session-metadata.py
```

If the script is not installed locally, use the bundled copy:

```bash
python3 <skill-directory>/scripts/session-metadata.py
```

The script reads `$CLAUDE_CODE_SESSION_ID` to locate the current session transcript.

### Step 2: Include in PR body

Append the output **after** the standard PR body (Summary + Test Plan) but **before** any `Generated with Claude Code` footer.

### Step 3: Fallback

If transcript parsing fails, add this note instead:

```
> ⚠️ Session metadata unavailable (transcript parse failed).
```
