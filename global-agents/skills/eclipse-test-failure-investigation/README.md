# Eclipse Test Failure Investigation — Pre-Setup Guide

This skill investigates two types of Eclipse test failures end-to-end, combining Jenkins,
Splunk, Jira, and local repo code tracing to produce a root cause and recommended fix:

1. **Cypress UI tests** — flaky or failing smoke/regression tests in `IQA-cypress-framework`
2. **Geneva Gateway API post-deployment tests** — REST endpoint failures in the
   `Castle API_Aeroby_Geneva PostDeployment Test Run (accounting)` pipeline (helmchart: `geneva-gateway`),
   where endpoints across Reports, Trading, SchemaDrivenCrud, Transactions, etc. are hit after
   each Geneva Gateway deployment. Failures here typically indicate a breaking change introduced
   by a recent deployment in the `geneva-gateway` repo.

---

## Prerequisites

You need **all four** of the following before the skill can run effectively.

### 1. MCP Servers

Two MCP servers must be configured and connected in your AI agent (e.g., GitHub Copilot in VS Code).

#### Jenkins MCP
Provides access to Jenkins build logs, failure excerpts, and console output.

Tools used by this skill:
- `jenkins-get_build_failure_excerpt`
- `jenkins-get_build_console_chunk`
- `jenkins-search_build_console`

Configure it in your MCP settings (`.vscode/mcp.json` or user settings):
```json
{
  "servers": {
    "jenkins": {
      "type": "http",
      "url": "https://<your-jenkins-mcp-host>/mcp"
    }
  }
}
```
> Ask your team lead for the Jenkins MCP endpoint URL.

#### Atlassian MCP (Jira)
Provides access to Jira tickets — reading descriptions, comments, and posting investigation summaries.

Tools used by this skill:
- `jira_get_issue`
- `jira_add_comment`

Configure in your MCP settings:
```json
{
  "servers": {
    "atlassian": {
      "type": "http",
      "url": "https://<your-atlassian-mcp-host>/mcp"
    }
  }
}
```
> Ask your team lead for the Atlassian MCP endpoint URL.

---

### 2. eclipse-splunk-investigation Skill

This skill depends on **eclipse-splunk-investigation** for all Splunk queries.
Install it first:

```bash
npx -y @github/gh-copilot-cli skill install eclipse-splunk-investigation
```

Or clone manually from `skills/eclipse-splunk-investigation/` in this repo into:
```
~/.agents/skills/eclipse-splunk-investigation/
```

Then complete the Splunk setup:
```bash
cd ~/.agents/skills/eclipse-splunk-investigation
python3 scripts/setup.py
```

This will prompt for your Splunk credentials and store the password securely in the OS keyring.

**Required environment variables** (or set via `.env` in the skill folder):
```
SPLUNK_HOST=splunk-awsprod.ezesoft.net
SPLUNK_USERNAME=your-username
```
Password is stored in keyring — do not put it in any `.env` file.

---

### 3. Local Repositories

The skill traces test implementations and deployment changes by reading source repos on your machine.

#### For Cypress UI investigations — at minimum:

| Repo | Purpose |
|---|---|
| `IQA-cypress-framework` | The main Cypress test repo — contains all specs |
| `IMSACNT-trialbalance-app` | Source for `nta*` / `ntb*` commands |

Clone from `code.ssnc.dev`:
```bash
git clone git@code.ssnc.dev:eze/IQA-cypress-framework.git
git clone git@code.ssnc.dev:eze/IMSACNT-trialbalance-app.git
```

Additional source repos are cloned on demand as new command prefixes are encountered.

#### For Geneva Gateway API post-deployment investigations — at minimum:

| Repo | Purpose |
|---|---|
| `IQA-api-automation` | Contains Aeroby JSON test definitions under `.aeroby/GenevaGateway/` |
| `geneva-gateway` | Source repo where deployments originate — used to check recent changes |

Clone from `code.ssnc.dev`:
```bash
git clone git@code.ssnc.dev:eze/IQA-api-automation.git
git clone git@code.ssnc.dev:eze/geneva-gateway.git   # ask your team lead if you don't have access
```

> The `geneva-gateway` repo may not be available to all team members. If you don't have it locally,
> ask your team lead or skip the deployment diff step — Jenkins + Splunk alone are usually sufficient.

---

### 4. gh CLI — authenticated to code.ssnc.dev

The `gh` CLI is used to raise PRs for fixes. Authenticate once:
```bash
gh auth login --hostname code.ssnc.dev
```

---

## First-Run Setup (config.json)

On first run, the skill will ask you for your local repo paths and save them to:
```
~/.agents/skills/eclipse-test-failure-investigation/config.json
```

Example:
```json
{
  "cypress_repo": "/Users/you/github/IQA/IQA-cypress-framework",
  "source_repos_root": "/Users/you/github/IMSACNT",
  "known_repo_paths": {
    "IMSACNT-trialbalance-app": "/Users/you/github/IMSACNT/IMSACNT-trialbalance-app"
  }
}
```

> `config.json` is gitignored — it stores local paths and must not be committed.

---

## assets/command-registry.json

Maps Cypress command prefixes to their npm package and source repo:

```json
{
  "command_prefixes": {
    "nta": {
      "package": "eze-e2e-cypress-nontradingactivity",
      "source_repo": "IMSACNT-trialbalance-app",
      "git_url": "https://code.ssnc.dev/eze/IMSACNT-trialbalance-app"
    }
  }
}
```

**Keep this file updated** as you discover new prefixes during investigations.
When the skill finds a command not in the registry, it will ask you to confirm the source
and will update the file automatically.

---

## Containerized Test Runs (Optional — for fix verification)

Once the skill identifies a root cause and implements a fix, it can verify the fix by running
the affected test N times in fresh Docker containers — no session reuse between runs — to
prove the fix is stable and the flakiness is gone.

To enable this, you need ECR access set up on your machine:

```bash
# From the IQA-cypress-framework root
bash scripts/ecr-login.sh
# Enter ADFS password when prompted, then approve Duo Push
```

ECR sessions expire every ~2 hours. Re-run the login script if you get auth errors.

The skill reads `scripts/run-e2e-local.sh` from the Cypress repo README to understand how
to invoke container runs, then executes them the requested number of times:

```bash
# Example: run castleSuite2 30 times in fresh containers
bash scripts/run-e2e-local.sh castleSuite2 <password> <api_password>
```

Each run builds a fresh Docker image (removing the old one first), so there is no state
bleed between runs. The skill reports a pass/fail summary across all runs as evidence.

---

## Checklist Before Your First Investigation

### Cypress UI tests
- [ ] Jenkins MCP connected and responding
- [ ] Atlassian MCP connected and responding
- [ ] `eclipse-splunk-investigation` skill installed and Splunk credentials set up
- [ ] `IQA-cypress-framework` cloned locally and on master
- [ ] At least one source repo cloned (e.g., `IMSACNT-trialbalance-app`)
- [ ] `gh` CLI authenticated to `code.ssnc.dev`
- [ ] `config.json` created (or skill will prompt on first run)

### Geneva Gateway API post-deployment tests
- [ ] Jenkins MCP connected and responding
- [ ] Atlassian MCP connected and responding
- [ ] `eclipse-splunk-investigation` skill installed and Splunk credentials set up
- [ ] `IQA-api-automation` cloned locally and on master
- [ ] `geneva-gateway` repo cloned locally (optional but recommended — ask team lead if not available)
- [ ] `gh` CLI authenticated to `code.ssnc.dev`
