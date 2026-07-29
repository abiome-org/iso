# ISO architecture

ISO is a conversational research system built vertically into the Pi coding-agent harness.
Autoresearch is not a detached script or an optional tool: it is the product's top-level execution
model.

## Product contract

The user talks to one agent. That agent owns the rest:

```text
human intent
    │
    ▼
durable preflight receipt
    │  objective + owned attempt lease exist before the first provider call
    │  ├── needs input / analysis only / failed
    │  └── pending
    ▼
principal-investigator conversation
    │  establishes objective, validated evaluator, constraints, and budget
    ▼
durable mission receipt
    │  accepted before calibration or research side effects
    ▼
durable local kernel
    ├── planner ─────────────── competing falsifiable hypotheses
    ├── worker pool ─────────── isolated Pi coding sessions + git worktrees
    ├── evaluator ───────────── repeated trusted measurements
    ├── selector ────────────── fresh post-selection replication gate
    ├── reflection ──────────── lessons, dead ends, and next focus
    └── evidence graph ──────── commits + lineage + append-only events
             │
             ├── conversational updates
             └── live operator dashboard
```

The named roles are architectural boundaries, not personas the user must manage. The principal
investigator should infer sensible configuration from the repository and ask only when a missing
choice would materially change the campaign or its safety.

### Conversational launch postcondition

ISO does not rely on a system prompt to make “one prompt starts the loop” true. The principal
entrypoint derives one stable session ID from the repository root and rejects flags that could change
the session, interaction mode, tools, extensions, prompts, or resource policy. Before the first
provider call for an objective, the kernel stores a digest-only preflight receipt keyed by that
session, the prior branch point, exact text digest, and ordered image digests. This distinguishes a
deliberately repeated later turn from a transport replay without copying expanded prompt text into
the kernel database.

Opening the receipt and claiming it for a unique principal-attempt ID happen atomically. The claim
has a 60-second lease renewed every 10 seconds while the model turn is responsible for the receipt.
Only the live owner can launch, defer, resolve, fail, or consume a correction. The kernel checks for
expired attempts at startup and every five seconds. Expiry releases ownership but leaves the
conversational receipt pending and bound to its stable session. A new principal process can reclaim
it with a new attempt ID after expiry; another attempt cannot take it while the old lease is live.
Unowned direct-automation receipts are a separate class and become durable `kernel_unavailable`
failures only after seven inactive days. The receipt can become:

- `launched`, linked to the durable mission receipt;
- `needs_input`, with one of three bounded reasons: metric ambiguity, credentials, or material cost;
- `analysis_only`, when the user explicitly did not request execution;
- `failed`, with a machine failure code.

If the principal returns prose without one of those outcomes, the harness gives it at most two
durably counted corrective turns. The correction and a `continuation_pending` outbox marker commit
together; the stable principal session recovers that exact continuation after a harness turn or
kernel interruption. Exhaustion is persisted as `postcondition_exhausted` and causes a one-shot
print/JSON execution to fail. Replaying a tool request or restarting the kernel does not consume a
correction twice. A `needs_input` response stores only reason/question/answer digests plus a bounded
redacted session marker, then resumes and leases that same receipt when the answer arrives.

Conversational launch derives a stable operation ID from the preflight ID and canonical frozen
mission input. Mission creation or exact deduplication, preflight-to-mission binding, and the
payload-bound response receipt commit in one `BEGIN IMMEDIATE` transaction. A retry can therefore
recover the same result even after that mission becomes terminal; a reused operation with different
input fails with an idempotency conflict.

Each preflight snapshots the state's admission epoch. Pause and stop increment the epoch in the same
transaction as their idempotent control receipt, including when no mission exists yet. Mission
acceptance and calibration compare the snapshot with the current epoch, so an older in-flight
principal turn or direct-launch calibration cannot cross a newer pause/stop barrier. Admission is a
database compare-and-swap boundary, not a timing assumption.

## Durable local kernel

The research loop must outlive a terminal view or browser tab. A local kernel owns orchestration and
is the single logical writer for active work. The Pi conversation, dashboard, and automation
commands are clients of the same kernel and state.

Campaign state is stored in `.iso/iso.db` using SQLite with write-ahead logging, full synchronous
commits, and immediate write transactions. The database contains:

- a mission record accepted before potentially long calibration begins;
- private preflight receipts and bounded correction counters;
- preflight-attempt owners, renewable expirations, and pending continuation markers;
- a monotonic admission epoch shared by conversational and direct launch;
- the current schema-versioned campaign graph;
- an append-only, monotonically ordered event ledger;
- idempotency receipts for commands;
- a material-progress outbox with per-mission acknowledgement cursors;
- one attempt row for every planner, worker, and critic provider call;
- renewable orchestration leases that prevent two kernels from running the same campaign.

In-memory worker handles are deliberately not treated as durable. At startup, reconciliation
separates pre-freeze work from post-freeze evidence. An unfinished worker that never produced a
candidate is marked interrupted and may consume a bounded retry. An experiment with a frozen
candidate keeps the same experiment row, candidate commit, screening plan, and confirmation plan;
`evaluating` returns to `candidate-frozen`, its existing generation stays active, and verification
resumes without provisioning another worker. Confirmed evidence and champion promotion normally
commit in one state transaction; reconciliation idempotently repairs legacy confirmed-evidence rows
that predate that invariant. A separately persisted run intent controls what happens next:
campaigns that were deliberately paused stay paused, while campaigns whose intent was still
`running` return to a ready boundary and the kernel resumes them automatically. Calibration
interrupted by a planned shutdown returns the mission to a retryable accepted phase rather than
misreporting a terminal failure. Pause and stop also apply before a campaign exists.

The conversation polls a bounded mission summary, not the full research graph. Material updates are
persisted with monotonically increasing cursors. Polling remembers a candidate acknowledgement for
each mission but does not advance it; the extension acknowledges only from `agent_end`, after the
model turn that received the update completes. If the process dies before that boundary, the update
is delivered again. Switching missions cannot overwrite another mission's pending acknowledgement.
A new chat session can therefore recover champion, failure, and completion notifications without
either silent loss or an unbounded replay.

Pre-freeze experiment terminalization and enqueueing its next worker attempt occur in the same state
transaction, capped at three experiment attempts. If pause or cancellation catches a claimed retry
before dispatch, ISO returns that claim to the queue instead of losing it. Post-freeze evaluator
retries never enter that queue: they remain on the same experiment, candidate commit, and already
frozen opaque plan. Candidate-controlled contract violations are terminal-invalid and cannot buy a
new draw. Provider-call retries have their own attempt rows, so failures and their usage do not
disappear behind a successful final call.

## Research state machine

### Calibration

Before generation one, ISO:

1. discovers staged, unstaged, deleted, and non-ignored untracked source changes;
2. copies admitted worktree bytes through the trusted quarantine and writes an immutable synthetic
   commit without changing the user's branch, index, or checkout;
3. resolves the evaluator's trusted control directory;
4. creates and verifies a content-addressed snapshot of installed dependencies;
5. hashes the evaluator command and control path, protected input bytes and modes, dependency
   manifests, installed dependency bytes, and Node/platform/architecture identity, while recording a
   separate runtime artifact digest for ISO, Pi, and sandbox artifacts;
6. executes every measured baseline sample in a fresh detached checkout;
7. rejects a baseline with invalid output or failed constraints;
8. persists metric direction, minimum useful improvement, concurrency, timeouts, and stopping
   budgets.

The source snapshot rejects changed credential-like files and excludes `.iso`, `.git`, and generated
dependency trees while retaining changed manifests and lockfiles. Its private `refs/iso/source-snapshots/*`
ref keeps it reachable. The resulting campaign becomes `ready`. Calibration is part of the evidence
chain, not setup hidden outside it. Baseline output is also checked against the declared metric,
constraint schema, and any declared score bounds. A direct launch captures its admission epoch before
source work, and calibration uses that same expected epoch, closing the pause/stop race across those
side effects.

### Evaluator policy

Evaluator code is privileged because it decides what “better” means. The principal cannot write
arbitrary repository files; it can submit only a bounded evaluator module. ISO:

1. stores a replaceable named draft with owner, mode, link-count, and no-follow checks;
2. syntax-checks the module without executing it;
3. dry-runs one complete `ISO_RESULT` sample in the evaluator sandbox against a disposable source
   checkout;
4. content-addresses the validated source;
5. revalidates the expected digest at launch and freezes that digest for the mission.

The mutable name can be reused for a later revision while prior frozen digests remain unchanged.
Draft locks carry a private owner record with process identity; a stale lock is reclaimed only after
that identity is no longer live. The model never supplies the executable command string: ISO
constructs it from its own Node runtime and the frozen absolute artifact path.

### Generation

A generation is pinned to one base commit: the current champion, or the calibrated source commit
when no candidate has won. ISO persists the generation before provisioning side effects. A
read-only planner sees the current code and accumulated evidence, then proposes a bounded mix of:

- `explore`: independent approaches that expand the search frontier;
- `exploit`: refinements based on measured positive signals;
- `verify`: replications or targeted tests of uncertain conclusions.

Ideas have fingerprints and parent links. Duplicate hypotheses can be rejected before consuming
compute.

Experiment intents are persisted before branch and worktree creation. Each worker receives a fresh
Pi session scoped to one candidate worktree under a private external worktree root. Its direct file
tools are realpath-contained; its shell is OS-sandboxed with a scrubbed environment, denied network
and credential paths, a private home/temp directory, the whole mutable live repository denied as one
stable boundary, and write access only to the candidate checkout. Files, directories, `.iso`
sentinels, and symlinks created in the live repository after policy construction remain hidden; only
the verified content-addressed dependency snapshot is reopened. If the sandbox cannot initialize,
the experiment does not run.

Agent edits are frozen into a candidate commit, covering paths Git reports as staged or unstaged,
deletions, and non-ignored untracked files. ISO freezes the current worktree bytes for each admitted
path rather than preserving a separate index version. This is a second trust transition rather than
a path-based `git add`: a new capture sandbox copies admitted regular files through descriptor checks
into a fresh quarantine the worker cannot write. It rejects links, concurrent mutation,
non-UTF-8/control paths, protected or sensitive files, more than 250 paths, files over 16 MiB, and
candidates over 64 MiB. Git plumbing hashes only verified, read-only quarantine blobs and
CAS-updates the experiment branch from its observed head.

### Verification and selection

Workers may run in parallel; evaluation is serialized. The evaluator command always runs from a
clean control checkout pinned to the campaign's source commit and rooted outside the mutable live
repository. Its module resolution uses the verified content-addressed dependency snapshot rather
than mutable live `node_modules`. The entire live repository is denied inside the evaluator sandbox
apart from exact verified frozen evaluator/dependency exceptions. The detached control checkout is
read-only, its `.git` metadata is hidden, outbound network and credential paths are denied, and only
a newly materialized evaluation checkout and private temp directory are writable. The candidate is
passed separately as `ISO_EXPERIMENT_DIR`, so ignored worker artifacts and mutable worker-directory
state never enter a measurement.

ISO creates no evaluator trial plan until the worker's candidate commit is frozen. It then
transactionally persists a screening plan containing cryptographically opaque trial IDs and a random
initial arm order. Every measured candidate and incumbent sample gets a fresh detached checkout.
Arms share the plan's `ISO_TRIAL_ID`, absolute `ISO_SAMPLE_INDEX`, and derived `ISO_SEED`; execution
order is counterbalanced AB/BA across the block. A retry or resumed verification reuses the exact
stored plan instead of silently drawing new trials. For sample means \(C\) and \(I\), ISO defines
beneficial improvement as:

```text
maximize: C - I
minimize: I - C
```

#### Exploratory screening

Screening uses a paired Student-t interval over per-sample differences when identities pair, with a
Welch fallback for legacy unpaired aggregates. These intervals are an exploratory ranking and
filtering device, not a campaign-wide error guarantee. A candidate remains screen-eligible only when
it:

- produced a real candidate commit;
- satisfies evaluator validity and all constraints;
- improves in the requested direction;
- clears the configured minimum useful improvement;
- clears the measured uncertainty bound.

Screening candidates are ranked deterministically by exploratory lower bound, not raw score. Exactly
one—the provisional winner—may advance. A failed replication does not cause ISO to try a second
screened candidate in the same generation; that generation plateaus.

#### Post-selection replication

Each 1-based generation index is one predeclared post-selection opportunity, bounded by
`maxGenerations`. The provisional winner receives exactly one new paired replication plan, separate
from its screening plan, after its candidate commit is immutable. ISO persists that plan before the
evaluator runs and reuses it on retry. Let \(M\) be `maxGenerations`, \(n\) the paired sample count,
and the campaign family-wise alpha be 0.05. Every opportunity uses the Bonferroni-adjusted
\(\alpha_g = 0.05/M\).

When the evaluator has declared finite guaranteed arm-score bounds \([L,U]\), baseline and every
sample are checked against those bounds. ISO uses the paired Hoeffding radius

```text
uncertainty = (U - L) × sqrt(2 × log(M / 0.05) / n)
lower_bound = direction_normalized_mean_difference - uncertainty
```

The evidence is labeled `bounded-independent-trials-fwer`. Its family-wise claim is conditional on
the recorded assumptions: independent direction-normalized paired trials, valid almost-sure score
bounds, one unseen fresh block per opportunity, correct pairing, and no more than \(M\) opportunities.
It is not a claim about dependent trials, selected or invalid bounds, or evaluator correctness.

Without declared finite score bounds, ISO uses a one-sided paired Student-t critical value at
\(\alpha_g\). The evidence is labeled `assumption-based-paired-student-t` and records the i.i.d./normal
paired-difference assumptions. Bonferroni accounts for the declared number of opportunities only
under those assumptions; this path is not distribution-free and is not a universal proof.

Both methods persist the claim class, assumptions, trial identities, opportunity index, family-wise
and adjusted alpha, sample count, improvement, uncertainty, lower bound, configured threshold, and
decision. Replication evidence is appended to the experiment's full durable history; bounded
dashboard/API projections may show only the recent tail without overwriting the stored record.
Promotion requires valid constraints, positive direction-normalized improvement, and
`lower_bound >= minimumImprovement`.

Invalid results, policy rejections, agent failures, replication failures, and measured losses remain
in the evidence graph.

### Reflection and stopping

After selection, a separate reflection pass receives the generation evidence. It records:

- lessons supported by results;
- measured dead ends that should not be retried blindly;
- promising next-focus areas;
- a reason to stop early, when applicable.

Before each generation, ISO evaluates generation, experiment, wall-clock, failure, consecutive
plateau, input-token, output-token, and model-cost budgets. Wall-clock and aggregate model budgets
are durable-boundary controls, not mid-call or provider-side hard caps. Model budgets use
provider-reported agent provenance; if a requested accounting dimension becomes unavailable, ISO
stops rather than pretending the budget is enforceable. Hard budget stops are deterministic. The
critic may additionally request early stopping through its structured result; ISO persists the
reason and deterministically honors that request.

Every provider call first creates an `agentCallAttempts` row with the exact pinned provider, model,
thinking level, role, generation, retry ordinal, and start time. Success, failure, cancellation,
timeout, interruption, usage, and cost close that same row. Restart reconciliation marks abandoned
running attempts interrupted. Campaign budgets sum this ledger—including failed retries—rather than
reconstructing cost from surviving agent output; missing accounting fails closed when that dimension
has a configured limit.

## Git for ideas

ISO treats git history and research lineage as one system:

```text
campaign
  └── generation (pinned base commit)
       ├── idea: explore
       │    └── experiment branch ── candidate commit ── measured result
       ├── idea: exploit
       │    └── experiment branch ── candidate commit ── measured result
       ├── idea: verify
       │    └── experiment branch ── candidate commit ── measured result
       └── reflection ── lessons + dead ends + next focus
```

When a candidate wins, the next generation branches from that candidate commit. This makes progress
real git ancestry rather than a folder of disconnected patches. The SQLite graph adds semantic edges,
measurements, failures, and reflections that commits alone cannot express.

## Dashboard and local control

`iso dashboard` starts or opens the local operator surface. The HTTP server is embeddable: kernel
code starts it, receives its bound address and control token, and can stop it without installing
process signal handlers. A blocking wrapper exists for direct CLI use.

Read-only snapshots and server-sent events drive:

- baseline, champion, cumulative/step improvement, dispersion, and recorded screening/replication
  uncertainty;
- campaign, generation, experiment, worker, and evaluator status;
- progress graph and candidate decision table;
- generation checkpoints, reflection memory, and a bounded, redacted recent event/provenance window;
- budget and plateau runway.

Token-protected mutations are deliberately narrow: start/resume, pause, stop, steer an active worker,
abort an active worker, or queue bounded campaign guidance for the next generation. Every mutation
carries the exact mission/campaign identity, a semantic control-state fingerprint, and an idempotent
action ID. The production kernel performs fresh-target validation and durable control transitions
through the same mutation coordinator used by chat and CLI controls. Pause, stop, and guidance
transitions commit with their durable receipts in one SQLite transaction. Start and resume commit
control intent before scheduling background work. Live worker steering and abort delivery are
best-effort because Pi's in-process control channel has no transactional delivery protocol. The
browser cannot change evaluator policy, execute arbitrary shell commands, read arbitrary files, or
provision credentials.

The server binds to `127.0.0.1` by default, sets restrictive browser headers, and generates a new
control token per process. That token prevents accidental cross-page mutation; it is not an identity
system or sufficient protection for a public endpoint.

## Trust model and current limits

| Boundary | What ISO enforces | Residual limit |
| --- | --- | --- |
| Principal | Exact ISO + bounded read-only repo tool allowlist; no project resource discovery | The model sees repository text the principal asks it to inspect |
| Worker | Path-contained file tools; OS-sandboxed shell; `.git` and control source hidden; network, sockets, credentials, and ambient env denied | On macOS a deliberately detached native child can outlive process-group cleanup; strict hostile-code containment needs an outer Linux VM |
| Evaluator | Detached source-pinned read-only control root; live repository denied except verified frozen evaluator/dependency paths; fresh candidate checkout; denied network/credentials; digest checked before and after | Evaluator source is trusted, not secret; an evaluator must not import hostile candidate code into its own result-emitting process |
| Candidate history | External worktree pinned to an exact base; bounded second-sandbox quarantine; descriptor-stable blobs; plumbing commit with one frozen parent | Capture is immutable per file, not an atomic multi-file filesystem snapshot |
| Concurrency | Durable orchestration and preflight-attempt leases, admission epoch, transactional state, atomic pause/stop/guidance receipts, intent-before-effect start/resume, serialized evaluator | Live worker control delivery is best-effort; one local machine, not distributed consensus |
| Results | Strict output/schema/bounds checks, frozen paired plans, exploratory screening, one fresh replication opportunity per generation, persisted assumptions, Bonferroni across `maxGenerations` | Bounded FWER depends on valid declared bounds and independent trials; the Student-t path depends on its distribution assumptions; neither establishes evaluator validity or causality |
| Dashboard | Loopback default, bounded/redacted projection, narrow semantic-targeted API, CSP, process-local bearer token | No multi-user identity or internet-safe authorization |

The sandbox is fail-closed and currently supported on macOS and Linux when its runtime dependencies
are installed. Linux strict operation depends on the sandbox runtime's PID namespace and
die-with-parent boundary. macOS uses Seatbelt plus process-group teardown and never reuses a
worker-writable sample path, but Darwin does not provide the same descendant-lifecycle guarantee.

Evaluator commands are trusted executable research specifications. They should use fixed local
datasets, run candidate programs as untrusted subprocesses rather than importing them into the
trusted result process, report hard constraints explicitly, and avoid placing secrets in captured
output. The local v1 dependency model is intentionally Node-only: Python virtual environments fail
closed, and dependency manifests are frozen rather than treated as an experiment surface. For
adversarial repositories, native compilers, kernel-facing workloads, or Python/toolchain research,
add a Linux VM as the outer runner boundary.

The detached kernel survives conversation and dashboard exits. Its durable intent is recovered the
next time a client starts the kernel, but automatic reboot/SIGKILL recovery requires a separate
launchd/systemd supervisor. Aggregate token and cost limits can stop only at generation boundaries
and depend on provider accounting. The wall-clock limit is also enforced at a generation boundary,
not by interrupting an in-flight call. Per-request provider-side spending and timeout limits remain
the outer hard caps.

## Planned remote operation at `iso.abiome.org`

This section is a deployment design target, not a shipped endpoint or current product capability.
Nothing in the local package deploys or configures Cloudflare, DNS, Access, Workers, Durable Objects,
D1, R2, or `iso.abiome.org`.
The planned remote design is outbound-only. Do not expose the local dashboard, kernel socket, or Pi
RPC surface through a raw tunnel.

```text
browser
  │ Cloudflare Access
  ▼
iso.abiome.org / Worker
  ├── SQLite-backed Durable Object per campaign
  │     ordered stream + authoritative idempotent command mailbox
  ├── D1 (optional): account/campaign directory and cross-campaign search
  └── R2: bounded logs, reports, benchmark artifacts, and diffs
             ▲
             │ outbound mutually authenticated WebSocket
             │
       ISO runner on a developer machine or isolated compute
         └── local kernel + Pi sessions + git worktrees + evaluators
```

The runner initiates the only connection across the trust boundary. The edge never dials a developer
machine. Human identity from Cloudflare Access and runner credentials remain separate. Commands are
transactionally written to the campaign Durable Object with idempotency keys before delivery. The
runner and browser use hibernatable WebSockets so a disconnected browser does not keep an edge
process alive. R2 delivery uses short-lived scoped URLs rather than relaying unbounded artifacts
through the control stream.

Recommended authorization tiers:

| Tier | Remote actions | Policy |
| --- | --- | --- |
| Observe | Graph, bounded logs, metrics, diffs, worker status | Access-authenticated team member |
| Guide | Start a configured campaign, pause, resume, steer, abort | Named operators |
| Mutate | Evaluator, secrets, compute adapter, sandbox policy | Local confirmation or two-person approval |
| Shell | Arbitrary command execution | Not part of the browser protocol |

Cloudflare Access must protect both page and API routes, with server-side JWT audience validation.
The runner uses a separate Access service token, browser roles are derived from validated Access
identity, and the `workers.dev` route should be disabled. The first remote release should expose
Observe and Guide only. Evaluator mutation, secrets, provisioning, and shell remain local until a
separate approval protocol exists. Remote relay, multi-user identity, and cloud compute adapters are
subsequent verticals; the current product is the durable local research loop.
