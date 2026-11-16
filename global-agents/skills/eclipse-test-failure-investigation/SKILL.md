---
name: eclipse-test-failure-investigation
description: >
  Investigates failing or flaky Eclipse Cypress UI tests end-to-end. Given a test name and
  error, gathers context from Jira, Jenkins, and Splunk, traces the failing test and its
  commands in local repos, and synthesizes a root cause with a recommended fix.
license: Proprietary
metadata:
  author: "@ssrivas1"
  version: "1.4.0"
  tags: "qa,cypress,testing,eclipse,debugging,flaky-tests"
  scope-roles: "qa"
  scope-products: "eclipse"
  scope-agents: "copilot"
  deprecated: false
  successor: null
---

# Eclipse Test Failure Investigation

Investigates failing or flaky Eclipse Cypress UI tests end-to-end by combining Jira, Jenkins,
Splunk, and local repo code tracing into a single cohesive root cause analysis.

---

## ⚠️ MANDATORY RULE — NEVER SKIP

Before reading ANY local repo (spec file, source repo, or any other file), you MUST ask:
> "Should I get latest from master for **[repo name]** before I proceed?"
>
> - If yes: `cd <repo_path> && git checkout master && git pull origin master`
> - If no: proceed with current state
>
> This applies to EVERY repo, EVERY time. No exceptions.

---

## INVESTIGATION FLOW — Follow This Order Exactly

### Step 1: Parse the error

When the user pastes a test failure (from Slack, Jenkins, or anywhere), extract:
- **Test name** — the full `it(...)` description
- **Spec file name** — if visible (e.g., `acctFixedIncomeWorkflows.spec.cy.ts`)
- **Error message** — the assertion that failed (e.g., `Grid has no data`, `expected '#x' to have value '...'`)
- **Suite name** — e.g., `AWSProd UI_Cypress SmokeEKS Test Run (Night Suite 1)`
- **Date/time of failure** — if not in the message, ask the user

**Recurring failure shortcut**: If this test+error was investigated recently (same session or prior checkpoint), first pull the new Jenkins build and confirm the package version is unchanged. If it is:
1. Skip Steps 4–6 (Splunk, spec file, command trace) — root cause is already known
2. Add an escalation comment to the existing Jira ticket with the new build link(s) and consecutive failure count or prompt user to create a new ticket if none exists.

---

### Step 2: Ask about Jira

Always ask:
> "Is there a Jira ticket associated with this failure? If yes, share the key (e.g., IMSACNT-12345).
> If not, that's fine — we'll proceed without it."

If a Jira key is provided:
- Use the Atlassian MCP `jira_get_issue` tool to read the full description, comments, and linked PRs
- Note any relevant context: recent merges, known issues, related fixes
- Keep this context in mind during the rest of the investigation

---

### Step 3: Jenkins

Ask:
> "Do you have a Jenkins build link for this failure? Note that Jenkins logs expire after a few
> hours — if the link is expired that's okay, we'll rely on Splunk."

If a Jenkins link is provided:
- Use Jenkins MCP tools to extract:
  - **Firm ID** (e.g., `TQ3Z9`, `T3XVP`) — needed for Splunk filtering
  - **Exact failure timestamp** — needed for Splunk time window
  - **Package versions** — e.g., `eze-e2e-cypress-nontradingactivity@0.1.470`
  - **Activity IDs / Correlation IDs** — if visible in logs
  - **Which step failed** and what immediately preceded it
- Use `jenkins-get_build_failure_excerpt` first for a quick summary
- Use `jenkins-get_build_console_chunk` to read surrounding context if needed

If Jenkins link is expired or not available:
- Ask the user for the firm ID and approximate failure time
- Proceed with Splunk using those values

---

### Step 4: Splunk

Ask:
> "Do you have a Splunk link for this failure? If yes, share it — it helps me start in the right
> context. If not, I'll build the query from the Jenkins context."

Use the **eclipse-splunk-investigation** skill for all Splunk queries.
Always run schema discovery (`list_fields`) before querying a new sourcetype.

Key queries to run:
1. **Per-minute timechart** around the failure window (±10 min) for the firm:
   ```
   index=main sourcetype="kube:container:peprocessor-service" FirmAuthToken="<firm>"
   | bin _time span=1m | stats count by _time
   ```
   This reveals race conditions — look for processing spikes that coincide with the assertion timing.

2. **Error/warn events** for the firm in the failure window:
   ```
   index=main (sourcetype="kube:container:peprocessor-service" OR sourcetype="kube:container:valuation-service")
   FirmAuthToken="<firm>" (Level=WARN OR Level=ERROR)
   | table _time Level Message ActivityName WorkflowName
   ```

3. **Specific activity traces** using any correlation/activity IDs from Jenkins.

Document findings: which activities were still running, what was empty, what WARNed.

---

### Step 5: Locate the Cypress spec file

Using the Cypress repo path from `config.json` (see Configuration section):
1. Search for the spec file by name: `find <cypress_repo> -name "<spec_file>" -type f`
2. If spec name is unknown, search by test name: `grep -r "<test name fragment>" <cypress_repo>/cypress/e2e/`
3. Read the relevant `it(...)` block and surrounding `beforeEach`/`afterEach` hooks

---

### Step 6: Discover and trace command source repos

From the spec file, extract all `cy.xxxYyy()` calls. For each unique prefix (`nta`, `trad`, `ntb`, `webfw`, etc.):

**A. Check the command registry** (`assets/command-registry.json`):
- If prefix found → use the `source_repo` value

**B. If not in registry** → search node_modules in the Cypress repo:
```bash
grep -r "Cypress.Commands.add(\"<commandName>" <cypress_repo>/node_modules/ --include="*.js" -l | head -5
```
This reveals which npm package provides the command.

**C. Find the source repo locally**:
1. Check `config.json` for known paths
2. Search the system: `find ~ -type d -name "<repo_name>" -maxdepth 7 2>/dev/null`
3. If found → use it
4. If not found → ask the user:
   > "I need the source repo for package `<package-name>` to trace the `<commandName>` command.
   > Do you have it locally? Should I clone it? Or skip this command for now?"
5. If cloned or path provided → save to `config.json` and `command-registry.json` for future runs

**D. Trace the command implementation:**
- Find the command definition: `grep -n "Commands.add(\"<commandName>" <repo>/cypress/support/ -r`
- Read the implementation
- Understand what API calls it makes, what it waits for (or doesn't), and what it assumes

---

### Step 7: Synthesize root cause

Connect all findings:
- What did the test do? (from spec)
- What did the command actually do under the hood? (from source repo)
- What was Splunk showing at that exact moment? (timing, errors, warnings)
- What context did Jira/Jenkins add?

Common patterns to look for:
- **Race condition**: command fires async work (API call) with no wait → test asserts before work completes
  - Signal: Splunk shows processing spike coinciding with NTA/assertion step; activities still running after test failed
- **Job polling no-assertion**: `cy.saWaitForScheduledJobLogSuccessful_v2(...)` called without `.should('be.true')` → always passes regardless of job completion
- **Loading indicator bug**: retry loop uses wrong selector state — element represents "done" state so `.should('be.visible')` is correct (NOT `.should('not.be.visible')`)
- **Date picker revert**: `{enter}` on a Kendo DatePicker closes the popup and reverts to the last committed internal value
- **404 config endpoint**: screen defaults to wrong date/state when metadata endpoint returns 404

---

### Step 8: Report

Produce **two blocks** — a full analysis for the conversation, then a separate Slack-ready summary the user can paste directly into a thread.

#### Full analysis (in conversation)
1. **Root cause** — one clear sentence
2. **Evidence** — Splunk timechart, log excerpts, code trace
3. **Recommended fix** — specific files and line numbers
4. **Secondary issues** — any other bugs found along the way
5. **Open questions** — anything that needs confirmation before implementing

#### Slack summary (paste-ready)
After the full analysis, output a Slack-ready plain-text summary the user can copy and paste
directly into a thread. Do NOT use any bold markers (`*text*`) — this CLI renders and strips
them before the user can copy. Use emojis and ALL-CAPS labels for visual structure instead.

Rules:
- No bold markers of any kind — plain text only
- Use emoji + ALL-CAPS as section dividers (e.g. `🔍 ROOT CAUSE`)
- No markdown tables — use labelled bullet lines (`• FIELD: value`)
- Backtick inline code is fine
- Keep the whole thing under ~25 lines so it fits a thread without scrolling

Example output:

--- Slack summary (copy from here) ---
🔍 ROOT CAUSE
<one sentence>

🧪 TEST: `<spec file>` → `<it() description>`
🏢 FIRM: <FirmAuthToken> | 🕐 TIME: <timestamp> | 🔗 Build #<n>

📋 EVIDENCE
• <key finding 1>
• <key finding 2>
• <key finding 3>

🔧 FIX
• <file and change>

⚠️ SECONDARY ISSUES (if any)
• <issue>

❓ OPEN QUESTIONS (if any)
• <question>
---

Offer to:
- Create a Jira story with the full findings, or add a comment to an existing ticket
- Implement the fix and raise a PR
- Verify the fix by running the affected test N times in fresh Docker containers (no session reuse) — casually mention this as an option, e.g. _"I can also run this 30 times in containerized mode to prove it's stable — want me to do that?"_

---

## Configuration

On first run (or if `config.json` is missing), ask the user to provide:

```json
{
  "cypress_repo": "/path/to/IQA-cypress-framework",
  "source_repos_root": "/path/to/github/root",
  "known_repo_paths": {
    "IMSACNT-trialbalance-app": "/path/to/IMSACNT/IMSACNT-trialbalance-app",
    "IQA-api-automation": "/path/to/IQA/IQA-api-automation"
  }
}
```

Save to `~/.agents/skills/eclipse-test-failure-investigation/config.json`.

> `config.json` is gitignored — it stores local machine paths and must not be committed.

**Auto-detect Cypress repo** if not configured:
```bash
find ~ -name "cypress.config.ts" -maxdepth 7 2>/dev/null | grep -v node_modules
```
Present results to the user for confirmation if multiple are found.

---

## Common Failure Patterns

| Error | Likely cause | Where to look |
|---|---|---|
| `Grid has no data` | Race condition — accounting not done before NTA assertion | Splunk peprocessor timechart; check what the triggering command does in source repo |
| `expected '#x' to have value 'M/D/YYYY' but was 'M/D/YYYY'` | Kendo DatePicker `{enter}` reverts value | Source repo — find `setNTA*Date` command; check for `{enter}` vs Kendo API approach |
| `expected element to be visible` | Loading state not waited for | Source repo — check `.should('be.visible')` on the "done-state" selector |
| `Cannot read properties of undefined` | DOM element not present — page not loaded | Check `beforeEach` for missing waits; Splunk for 404s on config endpoints |
| Test passes but NTA grid empty on next step | Job polling assertion missing `.should('be.true')` | Check spec for `saWaitForScheduledJobLogSuccessful_v2` call without assertion |
| `Expected to find element: [label="Trading"] > .fw-shell-sidebar-item-content, but never found it` paired with "Application Error: Eclipse failed to load" popup in screenshot | Transient microfrontend JS bundle load failure (CDN hiccup) — app's error boundary fired; nav sidebar never rendered. `Cypress.on('uncaught:exception', () => false)` silently swallowed the crash, so the test continued into a broken app state until timeout | Check backend health via Splunk `kube:container:platform-web` (look for 5xx). If all APIs are 200 and previous build passed → one-off transient, no fix needed. Confirm with next build. |
| `expected '<div.qs-quicksend-detail-col...>' to have class 'qs-quicksend-detail-disable'` (10s timeout) | `qsEnsureBannerState` cleanup step — AngularJS `ng-class` update after config toggle takes >10s under load | Check `eze-e2e-cypress-quicksend` version; 1.1.560+ uses 15s timeout. The 3-attempt retry in `ensureQuickSendBannerState` is **dead code** when `applyToggle` throws — retries only fire on banner-state mismatch, not assertion timeouts |
| `cy.find() failed because it requires a DOM element... cy.get(@selectedRow)` after rollback | AG Grid re-renders row on state change (e.g. Complete→Filled), detaching the DOM node and clearing `ag-row-selected` — stale `@selectedRow` alias | Trace `tradRollbackSelectedOrder` in `eze-e2e-cypress-trading`; replace post-rollback state check with `cy.tradWaitForWorkflowComplete()` |

---

## Key Domain Facts

- **Suite → FirmAuthToken mappings**: Use these to look up the Splunk `FirmAuthToken` directly from the suite name — no need to hunt through Jenkins logs.
  Each numbered suite has three scheduling variants — **Suite N**, **Night Suite N**, and **Weekend Suite N** — all sharing the same `FirmAuthToken`.

  **AWSProd — UI_Cypress (non-EKS)**
  | Suite Group | FirmAuthToken |
  |---|---|
  | Suite 1 / Night Suite 1 / Weekend Suite 1 | `TPKF5` |
  | Suite 2 / Night Suite 2 / Weekend Suite 2 | `T3XVP` |

  **AWSProd — UI_Cypress (EKS)**
  | Suite Group | FirmAuthToken |
  |---|---|
  | Suite 1 EKS / Night Suite 1 EKS / Weekend Suite 1 EKS | `TQ3Z9` |
  | Suite 2 EKS / Night Suite 2 EKS / Weekend Suite 2 EKS | `T78G5` |

  **AWSProd — Specialty / API suites**
  | Suite Name | FirmAuthToken |
  |---|---|
  | prodEmcSuite | `TT1D8` |
  | prodGenevaSuite | `T19X1` |
  | prodPartnerWidgetSuite / prodNightPartnerWidgetSuite | `TT9W3` |
  | API_Aeroby SmokeEKS (MarketData-eks) EKS | `TWF67` |
  | API_Aeroby Smoke (Bbgdl) | `T2DSB` |

  **Castle — UI_Cypress (non-EKS)**
  | Suite Group | FirmAuthToken |
  |---|---|
  | Suite 1 / Night Suite 1 / Weekend Suite 1 | `TEJ87` |
  | Suite 2 / Night Suite 2 / Weekend Suite 2 | `T17VP` |

  **Castle — UI_Cypress (EKS)**
  | Suite Group | FirmAuthToken |
  |---|---|
  | Suite 1 EKS / Night Suite 1 EKS / Weekend Suite 1 EKS | `TVZYC` |
  | Suite 2 EKS / Night Suite 2 EKS / Weekend Suite 2 EKS | `TASZP` |

  **Castle — Specialty / API suites**
  | Suite Name | FirmAuthToken |
  |---|---|
  | castleGenevaSuite | `TKXF5` |
  | API_Aeroby SmokeEKS (Geneva-eks) EKS | `TKXF5` |

- **Position event status** is the correct signal for "accounting is done" — NOT Trading WorkflowId
  - Poll `GET /v2/eventStatuses/positionEvents/{token}` until `EventStateId === 3` (Success)
  - EventStateId: 1=Initial, 2=Processing, 3=Success, 4=Faulted
- **peprocessor-service** is where lot-linking and valuation happen — always check this in Splunk for `Grid has no data` failures
- **Splunk field names are case-sensitive** — always run schema discovery before querying a new sourcetype
- **Splunk MCP uses local time (not UTC)** for `earliest_time`/`latest_time` parameters — always pass timestamps with a timezone offset (e.g., `2026-06-11T13:30:00-04:00`) to avoid off-by-hours mistakes
- **`imsclient` sourcetype** (browser console logs) may be empty or unavailable. For backend API health, use `kube:container:platform-web` (request/response logs with `StatusCode`, `UserName`, `FirmAuthToken`) and `kube:container:internal-api-gateway`. Start with `index=main TQ3Z9 | stats count by sourcetype` to discover what's indexed for the firm in the failure window.
- **`Cypress.on('uncaught:exception', () => false)`** is a common pattern in Eclipse specs to suppress third-party JS noise, but it also silently hides real app crashes (e.g., microfrontend load failures). When you see a timeout on a navigation selector with no obvious cause, check the failure screenshot for an "Application Error" modal — the crash was swallowed and the test ran blind against a broken app. Recommend changing to log-then-suppress: `Cypress.on('uncaught:exception', (err) => { cy.log(\`Uncaught exception: ${err.message}\`); return false; })`
- **Jenkins logs expire** in a few hours — extract firm ID, timestamp, and package versions immediately
- **Cypress command prefixes** map to npm packages: `nta`/`ntb` → `IMSACNT-trialbalance-app`, `trad` → `eze-e2e-cypress-trading`. See `assets/command-registry.json` for the full list.
- **Kendo DatePicker + AngularJS**: DOM, Kendo internal `_value`, and `ux-date-picker` directive form a 3-layer stack. `{enter}` closes the popup and can revert to Kendo's stale `_value` if Angular's `$digest` fires in the race window. Fix: use `kendoWidget.value(date)` + `kendoWidget.trigger('change')` atomically.
- **Loading indicator selector** `.trb-ntledger[fw-busy-indicator="false"]` targets the element in its DONE state — so `.should('be.visible')` correctly waits for loading to complete. Do NOT add `.should('not.be.visible')` after it.
- **Command registration precedence**: local imports in `commands.ts` (registered last) override npm package commands. Use this to test fixes without publishing a new package version.
- **QuickSend `ng-class` timing**: after clicking the QS config toggle, the `qs-quicksend-detail-disable` class is added by an AngularJS `ng-class` binding driven by the backend config-save response. Under load this can take 7–12+ seconds. `eze-e2e-cypress-quicksend` ≥1.1.560 uses a 15s timeout; earlier versions used 10s. Source repo: `E404-quicksend-app`.
- **`ensureQuickSendBannerState` retry is dead on assertion timeout**: the 3-attempt outer retry only triggers when `isBannerInExpectedState` returns false after a successful `applyToggle`. If `applyToggle` itself throws (Cypress assertion timeout), the error propagates immediately and retries never fire. When investigating QS disable flakiness, check which version of `eze-e2e-cypress-quicksend` was running and whether the failure was in `applyToggle` (config page) vs the blotter banner check.
- **AG Grid row deselection on re-render**: after any workflow action that changes `OrderState` (e.g. Rollback: Complete→Filled), AG Grid replaces the row's DOM node. The `ag-row-selected` class is lost, making `@selectedRow` aliases stale. Any `cy.tradGetSelectedOrder()` call after a workflow action is unreliable — use `cy.tradWaitForWorkflowComplete()` instead.
- **Jenkins `search_build_console` scans only the first ~131KB** regardless of `max_bytes`. For large logs (>131KB), use `get_build_console_chunk` with manual offset navigation. Each chunk is ~12KB; estimate offset by log timestamp density.
- **Jenkins `get_build_console_chunk` offset wrapping**: if a chunk at offset X returns pipeline boilerplate ("Started by timer…", "Running on EC2…") with `hasMore: false`, the offset exceeded the file size and Jenkins wrapped back to byte 0. Binary search backward (try X/2, then X*3/4, etc.) to find the actual end of the log.
