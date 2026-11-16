---
name: c4-architecture-diagrams
description: >
  Generates a full C4 architecture documentation suite for any codebase: knowledge graph,
  dependency map, L1–L4 Mermaid diagrams, dependency audit, and a manual level-by-level
  correctness walkthrough. Detects whether docs/c4/ already exists and runs in Greenfield
  (create from scratch) or Update (refresh changed sections) mode automatically.
  Use when asked to "generate architecture diagrams", "create C4 docs", "document the
  architecture", "create a dependency map", "diagram this repo", or "run the C4 process".
license: Proprietary
metadata:
  author: "@akieras"
  version: "1.0.0"
  tags: "architecture,c4,diagrams,documentation,dependency-map,mermaid"
  scope-roles: "dev"
compatibility: >
  Works with any codebase accessible in the workspace. Requires the
  codebase-graph-analyzer and agent-orch Claude Code plugins to be installed.
  uvx and Python 3 must be available on PATH for knowledge graph operations.
  Diagram output uses Mermaid syntax — renders natively in GitHub, GitLab, and
  VS Code with the Mermaid extension.
---

# C4 Architecture Diagrams

Produces a complete, verified C4 architecture documentation suite for any codebase in nine steps: from knowledge graph through to a manually verified set of diagrams where every node and edge is confirmed against the source code.

---

## Intent
Generate comprehensive C4 model architecture diagrams (System Context, Container, Component, and Deployment) that are rigorously verified against the actual source code.

## Context
Use this skill when a user asks to document the architecture, create a dependency map, or generate C4 diagrams for a repository. It is particularly useful for onboarding new developers to a complex codebase or auditing the current dependency surface of an application.

---

## Process

### Mode Detection
Before starting, check whether `docs/c4/` exists in the target repo:
- **Not found** → **Greenfield mode**: create all diagrams from scratch
- **Found** → **Update mode**: read `docs/c4/README.md`, identify what levels exist and their last-updated dates, then refresh only the sections that have changed

Tell the user which mode was detected before proceeding.

### Step 1 — Build the knowledge graph
Invoke the `codebase-graph-analyzer:build-graph` skill.

This calls `uvx code-review-graph build` and produces a searchable graph at `.code-review-graph/graph.db`. For a first-time build it does a full parse; subsequent runs are incremental.

**Verify it worked:**
```bash
uvx code-review-graph status
```
Expected output includes node/edge counts and a `Last updated` timestamp. A healthy graph for a medium React/TS repo (100–200 files) should show 500–1500 nodes and 5000–20000 edges.

---

### Step 2 — Explore the codebase
Invoke the `codebase-graph-analyzer:explore-codebase` skill.

This produces a structured read across four dimensions:
- **Architecture overview** — community map, cross-community edge counts, dominant languages
- **Community drill-down** — per-community member lists and cohesion scores
- **Execution flows** — critical paths ranked by criticality score with step-by-step traces
- **Complexity hotspots** — large functions ranked by line count

Note communities named `<noun>-<verb>` (e.g. `messages-handle`) — they map roughly to source directories and will inform the C4 component diagrams.

---

### Step 3 — Export the dependency map
Generate a markdown file titled `<ProjectName>_Dependency_Map.md` containing:
- Codebase overview (file/node/edge counts, languages)
- Source directory structure
- Community table (name, size, language, directory)
- Cross-community dependency table (from → to, edge count, relationship type)
- Critical flows table (name, criticality score, node count, description)
- Key architectural patterns in prose

This file serves as a living reference and as primary input for diagram generation.

---

### Step 4 — Generate C4 diagrams
Invoke the `agent-orch:c4` skill.

The skill auto-detects Greenfield vs. Update mode. In Greenfield mode it scans for entry points, Docker/Kubernetes/Helm files, package manifests, SDK imports, and environment variable files, then presents a plan listing what will be created. **Review the detected architecture before approving** — correct anything missed (e.g. unlisted backend services, non-standard auth patterns).

**Output files created:**
```
docs/c4/
├── README.md                  — index with key facts table
├── 01-system-context.md       — L1: system + users + external systems
├── 02-container.md            — L2: containers and communication
├── 03-component.md            — L3: internal components (one diagram per container)
└── decisions/
    └── README.md              — ADR template and log
```

---

### Step 5 — Fix diagram readability
Mermaid's `C4Context`, `C4Container`, and `C4Component` diagram types often suffer from label overlap because they do not use the dagre layout engine. 

If the diagrams are difficult to read, switch all diagrams to `flowchart LR` / `flowchart TB` with `subgraph` boundaries. Create versioned copies (e.g. `01-system-context-v2.md`) so the originals are preserved.

**Conventions that work well:**
- `flowchart LR` for system context (actors left, system centre, externals right)
- `flowchart TB` for container and component diagrams (top-down hierarchy)
- Group external systems into named `subgraph` blocks (e.g. `subgraph aws["AWS"]`)
- Keep edge labels to ≤ 4 words
- Omit labels on internal component arrows — node names carry the meaning

---

### Step 6 — Audit for missing dependencies
Verify if the diagrams satisfy the requirement: every upstream and downstream dependency must be identified (services, databases, message brokers, external APIs, infrastructure components).

Scan the following:
| What | Where |
|------|-------|
| All HTTP calls and hardcoded URLs | `src/**/*.ts`, `src/**/*.tsx` |
| All `process.env` / `window.envSettings` references | `src/`, `server/` |
| Environment config files | `config/*.env`, `.env*` |
| Server routes and middleware | `server/app.js` or equivalent |
| Content Security Policy headers | Server config |
| Docker / Helm / K8s manifests | `Dockerfile`, `deployment/` |
| npm registries | `.npmrc`, `package-lock.json` |
| Infrastructure tooling | `rancher-set-env.sh`, `terraform/`, `k8s/` |

**Common gaps to check for:**
- Backend services hidden behind an API gateway
- Separate analytics/BI APIs with their own base URL env var
- GraphQL endpoints (look for `/graphql` path patterns)
- Partner or third-party CDNs (check CSP `default-src` / `script-src`)
- Container image registry (AWS ECR, Docker Hub, Artifactory)
- npm registries used at build time (Artifactory, GitHub Packages)
- Service mesh sidecar (Consul, Envoy) — check pod annotations in Helm values
- Rancher / metadata services called at container startup

---

### Step 7 — Update diagrams and add deployment diagram
Once gaps are identified, update the container diagrams with all missing runtime services. Then create an L4 deployment diagram (`04-deployment.md`).

**`04-deployment.md` should include:**
1. **Deployment topology** (`flowchart TB`) — build pipeline → container registry → pod → sidecar → runtime services
2. **Startup sequence** (`sequenceDiagram`) — from infrastructure metadata fetch through to user-facing auth
3. **Health & ports table** — every exposed port and its health endpoint
4. **Infrastructure components table** — what each infra component does
5. **Environment config matrix** — which service URLs are active per environment (dev / uat / prod)

---

### Step 8 — Automated verification
For each diagram, extract every named node and verify:

**Internal containers/components:** Check that a matching directory or file exists under `src/`.

**External services — verify at least one of:**
- An environment variable referencing the service in `config/*.env` or `server/env.js`
- An HTTP call or SDK import in `src/`
- A CSP allowlist entry in server config
- An npm dependency in `package.json`

**Infrastructure nodes:** Check `Dockerfile`, `deployment/`, `.npmrc`, `values.yaml`.

**Edges — verify the protocol matches the code:**
- "HTTPS" → look for an axios or fetch call
- "postMessage" → look for `window.postMessage` or `addEventListener("message")`
- "OIDC" → look for Amplify or Cognito calls
- "iframe" → look for an iframe `src` attribute or `IFRAME_HOST` variable

Report per node: ✓ Confirmed / ⚠ Unverified / ✗ Missing from codebase

**Pass criteria:**
- All internal nodes have a matching `src/` path.
- All external services have verified evidence in the code.
- No node is named something that doesn't exist in the repository.
- Edge protocols are consistent with actual communication.

---

### Step 9 — Manual level-by-level walkthrough
Perform a deep-dive walkthrough to catch errors the automated pass misses. Step through each level (L1 $\rightarrow$ L4), identifying corrections and applying them before moving to the next level.

**Error categories to watch for:**
- **Phantom node**: Node with no matching directory or config entry.
- **Wrong subgraph placement**: Service placed in a subgraph it doesn't actually belong to.
- **Non-HTTP connection modelled as REST**: Iframe app shown as proxied backend.
- **Missing edge**: Hardcoded domain in nav component not shown.
- **Wrong edge direction**: Bidirectional protocol shown as one-way.
- **Dead code shown as active**: Commented-out integration shown with an active edge.
- **Wrong edge target file**: Handler shown linking to PubSub but only does console logging.
- **Stale description table**: Description row references a node removed from the diagram.
- **Wrong environment values**: Env matrix shows a URL in the wrong environment row.

**Level-specific checks:**
- **L1 System Context**: Disabled integrations confirmed as dead code; bidirectional protocols use `<-->` arrows.
- **L2 Container**: Services in the right subgraph; non-HTTP patterns correctly labelled; CDN dependency lists all portals that hardcode third-party domains.
- **L3 Component**: Directory-named nodes correspond to real directories; edge targets match actual imports in handler files.
- **L4 Deployment**: Startup sequence matches `start.sh`; disabled integrations have no active edges; env matrix matches `config/*.env` file content.

---

## Output Format

At the end of the process, `docs/c4/` will contain:
```
docs/c4/
├── README.md                      — index, key facts, navigation
├── 01-system-context-v2.md        — L1: flowchart syntax (preferred)
├── 02-container-v2.md             — L2: full dependency surface
├── 03-component-v2.md             — L3: one diagram per container
├── 04-deployment.md               — L4: infrastructure + startup sequence
├── DIAGRAM_GENERATION_GUIDE.md    — replicable generation guide
└── decisions/
    └── README.md                  — ADR index and template
```

Each diagram file must include:
- A `## Color Key` section (Mermaid legend).
- A `## <Level> Descriptions` table with a row per node explaining its role.
- Top and bottom navigation links between levels.

### Sign-off Checklist
Verify these categories are represented:
- [ ] All users / personas (human actors)
- [ ] All internal modules / services (containers)
- [ ] API gateway(s)
- [ ] All downstream backend services
- [ ] Authentication / identity provider
- [ ] All databases (relational, document, cache, time-series)
- [ ] Message brokers (Kafka, SQS, SNS, RabbitMQ, EventBridge)
- [ ] Logging / observability endpoints
- [ ] CDNs serving runtime assets
- [ ] Secrets management (Vault, AWS Secrets Manager, SSM)
- [ ] Container image registry (ECR, Docker Hub, Artifactory)
- [ ] Package registries used at build time (npm, Maven, PyPI proxies)
- [ ] Service mesh / sidecar (Consul, Envoy)
- [ ] Orchestration platform metadata services (Rancher, EC2 metadata)
- [ ] Any disabled / planned integrations (marked explicitly in diagram)
