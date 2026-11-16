#!/usr/bin/env python3
"""Parse the current Claude Code session transcript and output a markdown metadata table.

Uses segment-based categorization: all assistant turns between two user messages
form a "segment". The segment's mode is the highest-priority tool used anywhere
in that segment. This means implementation turns (Read/Edit/Bash) that follow a
Skill invocation count as "skill-driven work", not "direct prompting".

Priority: Skill > Agent > Plan > MCP > Direct
"""

import json
import os
import glob
import re
import sys


def find_transcript():
    session_id = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    if not session_id:
        return None
    for d in glob.glob(os.path.expanduser("~/.claude/projects/*/")):
        candidate = os.path.join(d, f"{session_id}.jsonl")
        if os.path.exists(candidate):
            return candidate
    return None


def is_tool_result(entry):
    """True if a type:'user' entry is a tool result, not a real user prompt."""
    content = entry.get("message", {}).get("content", [])
    if isinstance(content, str):
        return False
    if not isinstance(content, list) or len(content) == 0:
        return False
    return all(
        isinstance(b, dict) and b.get("type") == "tool_result"
        for b in content
    )


def detect_slash_commands(entry):
    """Extract skill names from <command-name> tags in a real user message."""
    content = entry.get("message", {}).get("content", [])
    texts = []
    if isinstance(content, str):
        texts.append(content)
    elif isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                texts.append(b.get("text", ""))
    found = []
    for t in texts:
        found.extend(re.findall(r"<command-name>\s*(\S+?)\s*</command-name>", t))
    return found


def classify_segment(segment_turns, slash_commands, details):
    """Classify all turns in a segment by the highest-priority tool used."""
    segment_mode = "direct"

    if slash_commands:
        segment_mode = "skill"
        details["skills_used"].extend(slash_commands)

    for turn_tools in segment_turns:
        for tool_name, tool_input in turn_tools:
            if tool_name == "Skill":
                segment_mode = "skill"
                skill_name = tool_input.get("skill", "unknown") if tool_input else "unknown"
                details["skills_used"].append(skill_name)
            elif tool_name == "Agent" and segment_mode not in ("skill",):
                segment_mode = "agent"
                details["agent_count"] += 1
                desc = (tool_input.get("description", "") if tool_input else "")
                if desc:
                    details["agent_descriptions"].append(desc)
            elif tool_name in ("EnterPlanMode", "ExitPlanMode") and segment_mode not in ("skill", "agent"):
                segment_mode = "plan"
                details["plan_count"] += 1
            elif tool_name.startswith("mcp__") and segment_mode not in ("skill", "agent", "plan"):
                segment_mode = "mcp"
                svc = tool_name.split("__")[1] if "__" in tool_name else tool_name
                details["mcp_tools"].add(svc)

    return segment_mode


def parse_transcript(path):
    categories = {"skill": 0, "agent": 0, "plan": 0, "mcp": 0, "direct": 0}
    details = {
        "skills_used": [],
        "agent_count": 0,
        "agent_descriptions": [],
        "plan_count": 0,
        "mcp_tools": set(),
    }

    entries = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                entries.append(json.loads(line.strip()))
            except Exception:
                continue

    current_segment_turns = []
    current_segment_assistant_count = 0
    current_slash_commands = []

    def flush_segment():
        nonlocal current_segment_turns, current_segment_assistant_count, current_slash_commands
        if current_segment_assistant_count > 0:
            mode = classify_segment(current_segment_turns, current_slash_commands, details)
            categories[mode] += current_segment_assistant_count
        current_segment_turns = []
        current_segment_assistant_count = 0
        current_slash_commands = []

    for entry in entries:
        entry_type = entry.get("type", "")

        if entry_type == "user":
            if is_tool_result(entry):
                continue
            flush_segment()
            current_slash_commands = detect_slash_commands(entry)
            continue

        if entry_type != "assistant":
            continue

        content = entry.get("message", {}).get("content", [])

        if isinstance(content, str):
            current_segment_assistant_count += 1
            current_segment_turns.append([])
            continue

        if not isinstance(content, list):
            continue

        turn_tools = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                tool_name = block.get("name", "")
                tool_input = block.get("input", {})
                turn_tools.append((tool_name, tool_input))

        current_segment_assistant_count += 1
        current_segment_turns.append(turn_tools)

    flush_segment()

    return {
        "categories": categories,
        "skills_used": list(dict.fromkeys(details["skills_used"])),
        "agent_count": details["agent_count"],
        "agent_descriptions": list(dict.fromkeys(details["agent_descriptions"])),
        "plan_count": details["plan_count"],
        "mcp_tools": sorted(details["mcp_tools"]),
    }


def format_markdown(data):
    cats = data["categories"]
    total = sum(cats.values())
    if total == 0:
        return None

    labels = {
        "direct": "\U0001f4ac Direct Prompting",
        "skill": "\U0001f9e9 Skill-Driven",
        "agent": "\U0001f916 Agent-Driven",
        "plan": "\U0001f4cb Plan Mode",
        "mcp": "\U0001f517 MCP Integrations",
    }

    lines = [
        "## \U0001f916 Session Metadata",
        "",
        "| Category | Segments | % of Session |",
        "|----------|--------:|-----------:|",
    ]

    for key in ["direct", "skill", "agent", "plan", "mcp"]:
        count = cats[key]
        if count == 0:
            continue
        pct = round(count / total * 100, 1)
        lines.append(f"| {labels[key]} | {count} | {pct}% |")

    lines.append(f"| **Total** | **{total}** | **100%** |")
    lines.append("")
    lines.append("<details>")
    lines.append("<summary>Details</summary>")
    lines.append("")

    skills_str = ", ".join(data["skills_used"]) if data["skills_used"] else "None"
    mcp_str = ", ".join(data["mcp_tools"]) if data["mcp_tools"] else "None"
    lines.append(f"- **Skills invoked**: {skills_str}")
    agents_str = ", ".join(data["agent_descriptions"]) if data["agent_descriptions"] else "None"
    lines.append(f"- **Agents dispatched** ({data['agent_count']}): {agents_str}")
    lines.append(f"- **Plan mode**: {'Yes' if data['plan_count'] > 0 else 'No'}")
    lines.append(f"- **MCP integrations**: {mcp_str}")
    lines.append("")
    lines.append("</details>")
    lines.append("")
    lines.append("> \U0001f4ca Auto-generated by `pr-session-metadata` · [Claude Code](https://claude.ai/code)")

    return "\n".join(lines)


def main():
    path = find_transcript()
    if not path:
        print("", end="")
        sys.exit(0)

    data = parse_transcript(path)
    md = format_markdown(data)
    if md:
        print(md)
    else:
        print("", end="")


if __name__ == "__main__":
    main()
