# ISO

ISO is a coding agent whose first priority is parallel autoresearch. The interface is a conversation:
tell ISO what should improve, and it turns that intent into a measured, resumable research campaign.

`@abiome/iso` is currently a private workspace package and is not published to npm. Build and run it
from this repository:

```bash
git clone https://github.com/abiome-org/iso.git
cd iso
npm ci --ignore-scripts
npm run build:offline

cd /path/to/target-repository
node /path/to/iso/packages/iso/dist/cli.js
```

Once `iso` is on `PATH`, the equivalent conversational entry points are:

```bash
cd your-repository
iso

# Or begin with the objective:
iso "Make the parser materially faster without changing its output"
```

ISO inspects the repository, establishes a metric and constraints, calibrates a baseline, generates
competing hypotheses, gives each hypothesis to a fresh Pi coding agent in an isolated git worktree,
and evaluates the resulting commits. Exploratory screening chooses one provisional winner per
generation; promotion requires that winner to clear a separately frozen post-selection replication
gate. Questions are reserved for choices the repository cannot answer safely.

The conversation remains the principal investigator. The planner, workers, evaluator, selector, and
reflection roles are internal machinery. Launch first creates a durable mission receipt; evaluator
calibration and the research loop then continue in the local kernel even if the terminal session ends.

## The one-prompt contract

ISO forces one repository-stable Pi principal session and rejects CLI flags that could replace the
session, interaction mode, tools, extensions, prompts, or other capability policy. Before ISO spends
a provider call on a new objective, the local kernel writes a digest-only preflight receipt keyed to
that session, the prior branch point, exact text digest, and ordered image digests. The expanded
prompt is not copied into the kernel database.

The receipt is atomically claimed by a unique principal-attempt ID with a renewable lease before the
model runs. Only that live attempt can launch, defer, resolve, or fail the objective. A kernel
watchdog expires abandoned ownership without failing the objective. The pending receipt remains
bound to its stable principal session, a fresh process can reclaim it after the prior lease expires,
and a still-live owner blocks competing attempts. A corrective turn is placed in a durable
continuation outbox and reclaimed by that same session. A clarification answer resumes the original
`needs_input` receipt rather than becoming a disconnected objective. Only unowned direct-automation
receipts—not conversational objectives—are failed as `kernel_unavailable` after seven inactive days.

The principal must produce one durable outcome: launch a mission, record the precise irreducible
input it needs, honor an explicit analysis-only request, or fail with a machine-readable reason.
Returning reassuring prose without an outcome triggers at most two durably counted corrective turns;
print/JSON mode exits nonzero if that postcondition is still unmet.

This makes autonomous launch a checked harness invariant rather than a suggestion in the system
prompt. Mission creation, exact-preflight binding, and the payload-bound launch response commit in
one SQLite transaction. Retried tool calls, kernel restarts, and ambiguous launch responses therefore
reuse the same intent, continuation, and mission receipts. Every preflight also records the current
admission epoch. A pause or stop increments that epoch transactionally, so an in-flight principal
turn admitted before the control barrier cannot create a mission afterward.

## The local research loop

Each campaign freezes:

- an immutable source commit built from HEAD plus admitted tracked, deleted, and non-ignored
  untracked worktree changes, subject to `.git`, `.iso`, dependency-tree, path/size, and
  sensitive-file exclusions, without changing the user's branch, index, or checkout;
- the evaluator command and a digest of its protected inputs;
- the primary metric, direction, minimum useful improvement, and constraints;
- sample count, timeouts, worker concurrency, and stopping budgets;
- the exact provider, model, thinking level, and token/cost ceilings used by every research role;
- a repeated baseline measurement.

Each generation then follows the same durable protocol:

1. Persist a generation intent pinned to the current champion commit.
2. Plan a mix of exploratory, exploitative, and verification hypotheses.
3. Persist experiment intents before creating branches or worktrees.
4. Run Pi coding agents concurrently, one worktree per candidate.
5. Freeze admitted bytes through a second sandbox into a bounded, worker-inaccessible quarantine,
   then create a plumbing commit with exactly the frozen base as parent.
6. Materialize a clean trusted evaluator checkout plus fresh detached candidate and incumbent
   checkouts for every measured sample.
7. After the candidate commit is frozen, persist a cryptographically opaque paired trial plan with
   trial IDs and counterbalanced arm order; reuse that exact plan across retries.
8. Evaluate candidate and incumbent against content-addressed dependencies with the plan's shared
   trial IDs, absolute sample indexes, and deterministic seeds.
9. Use exploratory paired/Welch screening to rank eligible candidates by lower bound, then give only
   the provisional winner one fresh post-selection replication opportunity for that generation.
10. Preserve negative results and reflect before the next generation.

The state and append-only event ledger live in `.iso/iso.db`. Experiment code remains inspectable in
git branches, so a research result is a reproducible commit rather than an ephemeral agent transcript.
Interrupted non-terminal work is reconciled to a durable state when the kernel restarts. A persisted
run intent keeps deliberate pauses paused and automatically resumes campaigns that were still meant
to run. Pre-freeze worker failures may consume a bounded new experiment attempt; once a candidate
commit exists, restart recovery preserves that exact experiment, candidate, screening plan, and
confirmation plan and resumes its existing generation. Candidate-invalid evaluator output is
terminal for that candidate, while transient evaluator failures retry the same frozen identity
instead of drawing a replacement. Confirmed evidence and champion promotion commit together, with an
idempotent legacy reconciliation path. Material updates use a durable outbox and per-mission
acknowledgement cursor. Polling does not consume an update: the conversation acknowledges it only
after the agent turn that received it completes, so a crash before turn completion causes safe
redelivery instead of silent loss.

Every planner, worker, critic, failed retry, timeout, cancellation, and interrupted call has its own
attempt row. Provider-reported tokens and cost are charged from that ledger, including failures; if a
configured budget cannot be accounted for, the campaign stops rather than silently exceeding it.

## Promotion evidence

Screening measurements are exploratory: their paired Student-t or Welch intervals rank and filter
candidates, but do not carry a campaign-wide error claim. Each generation is one predeclared
post-selection opportunity, and only its top screened candidate receives one fresh paired replication
block. The block plan is created after the candidate commit is immutable, is separate from the
screening plan, and is persisted before evaluator execution.

ISO fixes the family-wise alpha at 0.05 and applies Bonferroni across the configured
`maxGenerations`, so opportunity \(g\) uses \(\alpha_g = 0.05 / \text{maxGenerations}\). The evidence
record stores the method, claim class, assumptions, trial identities, opportunity index, adjusted
alpha, effect, uncertainty, lower bound, threshold, and decision.

When the evaluator declares finite guaranteed score bounds \([L,U]\), every observed baseline and
arm score is checked against them. ISO then uses the distribution-free paired Hoeffding radius

```text
(U - L) × sqrt(2 × log(maxGenerations / 0.05) / samples)
```

and labels the result `bounded-independent-trials-fwer`. That family-wise claim requires the recorded
assumptions, especially independent direction-normalized paired trials, valid almost-sure bounds, one
fresh block per opportunity, and no more than the predeclared opportunities. If bounds are not
declared, ISO uses a one-sided paired Student-t bound at the Bonferroni-adjusted alpha and explicitly
labels it `assumption-based-paired-student-t`; it is not a distribution-free proof. In either case,
promotion requires positive measured improvement and a lower bound at least as large as the configured
minimum useful improvement. Small samples, dependence, evaluator misspecification, and invalid bounds
can still invalidate the scientific conclusion.

## Operator dashboard

```bash
iso dashboard
```

The local dashboard shows:

- baseline, champion, cumulative and step improvement, dispersion, and recorded
  screening/replication uncertainty;
- generation, experiment, failure, and plateau budgets;
- a bounded live view of the campaign → generation → idea → experiment → result → reflection graph;
- candidate commits, selection decisions, and negative-result memory;
- active Pi workers with steer and abort controls;
- campaign guidance that is queued as an operator note for the next generation;
- start, resume, pause, and stop controls;
- a bounded, redacted recent event/provenance window and evaluator digest; the full append-only
  ledger remains in `.iso/iso.db` and the evidence query API.

The dashboard binds to loopback by default. Mutations require a random process-local control token
injected into the page. Each action also names the exact mission/campaign and expected semantic
control state. Pause, stop, and guidance transitions commit durable state and their idempotency
receipts in one SQLite transaction. Start and resume persist control intent before scheduling
background work. Live worker steering and abort delivery remain best-effort. This is local control,
not internet authentication.

## Evaluator contract

Most users should let the ISO conversation establish the evaluator. ISO keeps a replaceable named
draft, syntax-checks and dry-runs it in the same sandbox used for measurements, then freezes the
validated bytes under a content-addressed path at mission launch. A bad draft can therefore be
repaired before it becomes immutable research policy.

For custom evaluators, the command runs from its trusted control directory and receives the candidate
checkout in `ISO_EXPERIMENT_DIR`. It must exit successfully and print a final result line:

```text
ISO_RESULT {"score":41.2,"metrics":{"coverage":92.4},"valid":true,"constraints":{"tests":true},"summary":"optional"}
```

`score` and all secondary metrics must be finite numbers. `valid` defaults to `true`; every named
constraint must be true for the sample to be accepted. Baseline calibration freezes the metric and
constraint key schema; every later sample must match it exactly, and every score must satisfy any
declared finite bounds. ISO supports warmups, repeated samples, timeouts, bounded output capture,
process-group cancellation, and stable per-trial environment values: `ISO_TRIAL_ID`,
`ISO_SAMPLE_INDEX`, and `ISO_SEED`. Candidate code can read these values only after its commit is
frozen, and the trial ID does not disclose which arm is incumbent or candidate.

## Trust boundary

ISO uses git for reproducibility and an OS sandbox for containment. On macOS and Linux:

- worker read/edit/write tools are realpath-contained to one disposable checkout and reject symlinks,
  parent traversal, `.git`, `.iso`, protected evaluator inputs, and multiply linked files;
- worker shell commands receive a scrubbed environment, no outbound network or local sockets, no
  credential paths, a private home/temp directory, and write access only to their checkout; the
  mutable live repository is denied as one stable boundary, including files or symlinks created
  after the sandbox policy was constructed, with only the verified dependency snapshot reopened;
- evaluator commands run from a clean source-pinned control checkout with a verified
  content-addressed dependency view; the control checkout is detached from the mutable live
  repository, which is denied wholesale except for the verified content-addressed dependency view
  and exact inode/link/digest-verified frozen evaluator artifacts, and the evaluator receives write
  access only to the fresh evaluation checkout and private temp directory;
- candidate bytes cross into git only through a second read-confined capture sandbox with regular
  file, hard-link, stability, path-count, per-file, and aggregate-byte checks;
- the principal conversation has no shell or general write tools. It can only inspect bounded
  repository text, prepare and validate an evaluator draft, and operate the ISO kernel;
- project extensions, skills, prompts, themes, and context files are disabled for principal,
  planner, worker, and critic sessions.

ISO fails closed when the sandbox runtime or its OS dependencies are unavailable. Git worktrees are
not themselves a security boundary, and evaluator code remains trusted. Evaluators should execute
hostile candidate programs out of process rather than importing them into the trusted
result-emitting process.

Local v1 intentionally supports Node dependency layouts only and freezes package manifests;
`.venv`/`venv` layouts fail closed. A detached native child can outlive process-group tracking on
macOS even though unique paths and the quarantine prevent it from contaminating later samples or
candidate commits. Use a Linux VM for adversarial native toolchains or strict descendant lifecycle,
and do not place a public tunnel directly in front of the local server. The kernel survives ordinary
chat and dashboard exits and recovers after it is restarted; installing an OS-level launchd/systemd
supervisor for reboot recovery is a deployment step, not part of the local package yet. See
[`../../docs/iso-architecture.md`](../../docs/iso-architecture.md) for the complete model and the
planned, not-yet-deployed outbound-only remote-control design. `iso.abiome.org`, Cloudflare Access,
the Durable Object relay, remote command delivery, multi-user identity, and cloud compute adapters
are not current local-package capabilities.
