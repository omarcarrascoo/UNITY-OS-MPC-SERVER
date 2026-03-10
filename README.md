
# 🧠 Unity OS

> Because sometimes you need to keep shipping without a computer.

Unity OS is an experimental **autonomous development agent** that works through Discord and applies real code changes in a controlled workspace.

Think of it as **Jarvis for developers**.

Instead of controlling an Iron Man suit, it:

- Reads and edits your code
- Understands your repository architecture
- Installs dependencies
- Runs development commands safely
- Generates pull requests
- Builds UI from Figma
- Runs your app
- Captures screenshots
- And eventually… manages your entire development workflow

Yes, it's ambitious.  
Yes, it's slightly insane.  
And yes — it actually works.

---

# 🚀 What It Does Today

Unity currently operates as a **Discord-driven autonomous development agent**.

Capabilities:

- Reads and edits code through a constrained tool layer
- Scans project architecture and applies `.unityrc.md` rules
- Uses short‑term memory from `git diff` for reply-based iterations
- Installs dependencies and runs safe development commands
- Generates validated TypeScript edits with a self‑healing loop
- Captures Expo screenshots with Puppeteer and returns preview links
- Creates Smart PRs from the final session diff

---

# 🏗 System Architecture

```mermaid
flowchart TD
    %% Entradas de Usuario
    U[Discord User in #jarvis-dev] --> D[index.ts Orchestrator]
    
    %% Cadenero y Seguros
    D --> Locks{Locks: isProcessing? Unsaved work?}
    Locks -->|Locked| Reject[Send Warning Message]
    Locks -->|Clear| Type{Is Iteration?}

    %% Preparación del Contexto
    Type -->|No| W[prepareWorkspace: clean environment]
    Type -->|Yes| Diff[Get git diff: Short-Term Memory]

    W --> F[getFigmaContext]
    Diff --> F

    F --> S[Scanner: getProjectTree & getProjectMemory]

    %% Bucle Principal de la IA
    S --> AI[generateAndWriteCode - src/ai.ts]
    
    subgraph Self_Healing_Loop [The Arena: Self-Healing Agent Loop]
        AI --> LLM[DeepSeek LLM]
        
        %% Herramientas
        LLM -->|Tool Calls| T[Tool Layer: read_file, search, run_command]
        T --> Repo[(Target Repo in Workspaces)]
        T --> LLM
        
        %% Inyección y Validación
        LLM -->|JSON Output| Edits[Apply Surgical Edits]
        Edits --> Repo
        Edits --> TS[TypeScript Validation: npx tsc --noEmit]
        
        %% Auto-corrección
        TS -->|Patch Error / TS Error| Truncate[Truncate Error & Feedback to Prompt]
        Truncate --> LLM
    end

    %% Salida de la IA y Snapshots
    TS -->|Success| Snap[takeSnapshot - src/snapshot.ts]
    Snap --> Ex[Ngrok + Expo/Puppeteer Preview]

    %% Interfaz de Discord y Acciones
    Ex --> UI[Discord Reply: Screenshot, URLs & Buttons]

    %% Botones de Acción
    UI -->|Click: ✅ Approve & PR| SmartPR[generatePRMetadata: Read full diff]
    SmartPR --> PR[createPullRequest - src/git.ts]
    
    UI -->|Click: 🗑️ Revert| Reset[git reset --hard & clean]
    
    UI -->|Click: 🛑 Cancel Task| Abort[AbortController triggers AbortError]
    Abort --> Reset
```

Unity operates as a **tool‑driven AI system**.

The AI **never directly modifies files or runs arbitrary commands**.  
Everything happens through a controlled tool interface.

---

# ⚙️ Core Components

### `index.ts`
Discord entrypoint responsible for:

- receiving prompts
- managing sessions
- concurrency locking
- approve / revert workflow
- orchestrating the agent pipeline

---

### `src/ai.ts`

The brain of the system.

Handles:

- reasoning loop
- tool orchestration
- JSON edit contract
- TypeScript compiler self‑healing
- smart commit messages

Unity loops until the generated code compiles.

---

### `src/tools.ts`

The tool layer exposed to the AI.

Available tools:

| Tool | Purpose |
|-----|------|
read_file | inspect project files |
search_project | search the repository |
run_command | run safe development commands |

Each tool enforces **path validation and command restrictions**.

---

### `src/git.ts`

Workspace manager.

Handles:

- cloning repositories
- resetting workspace
- installing dependencies
- detecting frontend/backend modules
- creating Pull Requests

---

### `src/scanner.ts`

Builds a **token‑optimized project map**.

Example structure:

```
app/
  login.tsx
components/
  Button.tsx
api/
  auth.ts
```

Also loads:

```
.unityrc.md
```

Which acts as **long‑term architecture memory**.

---

### `src/figma.ts`

Design‑to‑code integration.

Responsibilities:

- parse Figma URLs
- fetch design nodes
- clean and compress node JSON
- cache responses

This provides layout context for the AI.

---

### `src/snapshot.ts`

Preview generation pipeline.

```mermaid
flowchart LR
    C[Generated Code] --> B[Start Backend]
    B --> N[Open ngrok Tunnel]
    N --> F[Launch Expo Web]
    F --> P[Puppeteer]
    P --> S[Mobile Screenshot]
```

Unity runs the project and returns a **visual preview** of the generated UI.

---

### `utils/register-commands.ts`

Registers Discord slash commands:

```
/workon
/status
/init
```

These control the active workspace.

---

# 🔁 Agent Workflow

```mermaid
flowchart TD
    P[User Prompt]

    P --> D{Detect Figma Link?}

    D -->|Yes| F[Figma MCP Fetch Nodes]
    F --> CL[Filter / Clean Figma Nodes]

    D -->|No| R

    CL --> R[Agent Reasoning]

    R --> T[Tool Call]
    T --> C[Tool Result]
    C --> R

    R --> E[Code Edits]
    E --> V[TypeScript Validation]
    V --> S[Snapshot]
    S --> U[User Approval]
    U --> PR[Pull Request]
```

The AI gathers context before making any change.

---

# ✂️ Agent Edit Contract

Jarvis writes structured edits:

```json
{
  "targetRoute": "/path",
  "commitMessage": "feat: summary",
  "edits": [
    {
      "filepath": "relative/path.tsx",
      "search": "exact existing code",
      "replace": "new code"
    }
  ]
}
```

Rules:

- If `search` does not match exactly → edit fails safely
- AI must regenerate patch
- prevents destructive overwrites

---

# 🔐 Safety Model

Unity includes several guardrails.

### Path Protection

Blocks paths outside repo root:

```
../
~
/root
```

---

### Command Whitelist

Only safe commands allowed:

```
npm install
npm run
npx expo
npx tsc
```

---

### Workspace Integrity

- prevents overlapping runs
- blocks tasks if repo has uncommitted changes
- edits are applied atomically

---

# 🛠 Installation

## Requirements

- Node.js 18+
- npm
- Git
- Discord bot + application
- GitHub token
- DeepSeek API key
- Figma token (optional)
- ngrok (optional)

---

## Setup

```bash
git clone
cd unity-os
npm install
```

Create `.env`:

```
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_client_id
GITHUB_TOKEN=your_github_token
GITHUB_OWNER=your_github_org_or_user
GITHUB_REPO=target_repo_name
FIGMA_TOKEN=your_figma_token
DEEPSEEK_API_KEY=your_deepseek_key
```

Register slash commands:

```bash
npx tsx utils/register-commands.ts
```

Start Jarvis:

```bash
npm run dev
```

Expected log:

```
🤖 Jarvis Architect listening on Discord...
```

---

# 💬 Usage

1. Go to `#jarvis-dev`
2. Send a prompt

Example:

```
Create a login screen using our theme tokens
```

Unity will:

1. analyze the repo
2. generate code
3. validate TypeScript
4. run the app
5. capture preview
6. offer Pull Request

Reply to the same message to iterate.

---

# 🔌 MCP Server Blueprint (Future Layer)

Unity can evolve into an **MCP-compatible system**.

```mermaid
flowchart TD
    %% LAYER 1: Omni-Channel Inputs (Where requests come from)
    subgraph Layer 1: Omni-Channel Interfaces
        D[Discord Bot<br/>#jarvis-dev]
        MCP[MCP Clients<br/>Cursor / Claude / VSCode]
        W[WhatsApp / Telegram]
        API[REST API / Webhooks]
    end

    %% LAYER 2: Orchestration & Event Routing
    subgraph Layer 2: Unity Core OS
        EB((Central Event Bus))
        Router{Unity Orchestrator<br/>Intent Classifier LLM}
    end

    D --> EB
    MCP --> EB
    W --> EB
    API --> EB
    EB --> Router

    %% LAYER 3: Memory Systems (The "State" of the OS)
    subgraph Layer 3: Memory & Context
        STM[Short-Term Memory<br/>Git Diffs / Session Cache]
        LTM[Long-Term Memory<br/>.unityrc / Architecture Rules]
        VDB[(Vector Database<br/>User Profiles / Past Work)]
    end

    Router <--> STM
    Router <--> LTM
    Router <--> VDB

    %% LAYER 4: Specialized Autonomous Agents
    subgraph Layer 4: Specialized Brains
        Dev[👨‍💻 Dev Brain<br/>'Jarvis']
        Fin[💸 Finance Brain<br/>Receipts & Ledger]
        Vis[👁️ Vision Brain<br/>Image Analysis]
        Ops[⚙️ Ops Brain<br/>CI/CD & Monitoring]
    end

    Router -->|Code/Arch Tasks| Dev
    Router -->|Expenses/Data| Fin
    Router -->|Images/Docs| Vis
    Router -->|Deployments/Logs| Ops

    %% LAYER 5: Tool Registries (What each brain can do)
    subgraph Layer 5: Tool Execution Layer
        DevTools[read_file, run_command<br/>take_snapshot, tsc, search]
        FinTools[extract_ocr, parse_receipt<br/>save_to_mongo]
        OpsTools[trigger_deploy, fetch_logs<br/>restart_server]
    end

    Dev --> DevTools
    Fin --> FinTools
    Ops --> OpsTools

    %% LAYER 6: The Physical World
    subgraph Layer 6: Target Environments
        Repo[(Local Workspaces<br/>& Git Repos)]
        DB[(MongoDB<br/>Atlas)]
        Cloud[(Railway / Vercel<br/>AWS)]
    end

    DevTools <--> Repo
    FinTools <--> DB
    OpsTools <--> Cloud
```

### MCP Mapping Plan

- Wrap `src/tools.ts` functions as MCP `tools/call`
- Provide context as MCP `resources`
- Expose workspace + snapshot operations
- Allow external agents to call Unity tools

---

# 🧠 Future Vision

Unity currently runs as a **single development agent**.

Future architecture:

```mermaid
flowchart TD
    U[User] --> R[Router Agent]
    R --> D[Dev Brain]
    R --> V[Vision Brain]
    R --> F[Finance Brain]
    R --> O[Ops Brain]
    D --> MCP[MCP Tool Network]
    V --> MCP
    F --> MCP
    O --> MCP
```

Potential capabilities:

- automated debugging
- receipt analysis
- infrastructure monitoring
- multi‑project development
- personal knowledge orchestration

In other words:

Unity starts as a **developer assistant**  
and evolves into an **AI operating system**.

---

# ⚠️ Disclaimer

Unity can:

- modify repositories
- run commands
- create pull requests

Use responsibly.

Version control is your friend.

---

# 📜 License

MIT

Do whatever you want.

Just maybe don’t build Skynet.
