# ISO architecture

ISO is a research control plane built into the Pi coding-agent harness. Autoresearch is the primary
workflow; the CLI, agent runtime, git graph, evaluator, and dashboard are views of the same state
machine.

## First vertical

```text
human / director
       │ hypotheses
       ▼
  ISO campaign ───────► idea graph + evidence ledger
       │
       ├── git worktree A ── Pi coding agent ── evaluator ── result A
       ├── git worktree B ── Pi coding agent ── evaluator ── result B
       └── git worktree C ── Pi coding agent ── evaluator ── result C
                                      │
                                      └── commit + provenance + failure memory
```

The director is constrained to Pi's read-only tools. Experiment workers receive normal coding tools
inside isolated worktrees. The evaluator is repository-owned and deterministic; it is the authority
for champion selection. ISO keeps losing and failed experiments because negative results are inputs
to the next director pass, not disposable logs.

`.iso/state.json` is the local source of truth for the MVP and is intentionally ignored by git.
Experiment code is durable in `iso/*` branches. The first batch branches from the campaign's current
commit; later batches branch from the measured champion, turning progress into real git ancestry
instead of a collection of unrelated patches. A later storage adapter can mirror graph records to D1
without changing the runtime model.

## Dashboard and local control

`iso serve` binds to `127.0.0.1` by default and serves:

- campaign status, metric, champion, and iteration budget;
- a live idea → experiment → result graph;
- Pi worker activity over server-sent events;
- start, pause, steer, abort, and human idea submission;
- the append-only evidence ledger.

Mutating requests require a process-local control token injected into the dashboard document. The
API deliberately does not expose an arbitrary shell endpoint or allow the evaluator command to be
changed remotely.

## Recommended `iso.abiome.org` design

Do not put a Cloudflare Tunnel directly in front of the local HTTP server or Pi RPC socket. That
turns an authentication mistake into remote shell access.

Use an outbound runner architecture:

```text
browser
  │ Cloudflare Access
  ▼
iso.abiome.org / Worker
  ├── Durable Object per campaign: ordered event stream + command mailbox
  ├── D1: campaigns, ideas, experiments, measurements, audit records
  └── R2: logs, reports, benchmark artifacts
             ▲
             │ outbound authenticated WebSocket
             │
       ISO runner on developer machine / VM
         └── local Pi sessions + git worktrees + evaluators
```

The runner initiates the only connection across the trust boundary. The edge never dials the
developer machine. Every runner has a revocable credential; commands carry an idempotency key and
are written to the audit ledger before delivery.

Recommended control tiers:

| Tier | Remote actions | Policy |
| --- | --- | --- |
| Observe | graph, logs, metrics, diffs, worker status | Any Access-authenticated team member |
| Guide | start a configured campaign, pause, resume, steer, abort | Named Abiome operators |
| Mutate | change evaluator, secrets, compute provider, or sandbox policy | Local confirmation or two-person approval |
| Shell | arbitrary command execution | Not part of the browser protocol |

Cloudflare Access should protect both the custom hostname and API routes. The Worker should validate
the Access JWT audience, not merely test for the presence of a header. Runner credentials remain
separate from human identity. Cloudflare's `workers.dev` route should be disabled for the control
deployment.

## Compute adapters

The local runner is the first adapter. The same campaign scheduler can later target SSH, Modal,
Kubernetes, or dedicated GPU runners as long as an adapter can create a workspace, start a Pi
session, stream events, run the evaluator, and return a git ref plus artifacts.

The edge schedules intent; runners own compute. This separation makes “spin stuff up” possible
without placing cloud credentials or unrestricted machine capabilities in the web application.

## Near-term build order

1. Harden the current local vertical with evaluator fixtures, worktree cleanup policy, and resumable
   experiments.
2. Add the outbound runner protocol and Cloudflare Durable Object relay.
3. Mirror the state graph to D1 and artifacts to R2.
4. Put `iso.abiome.org` behind Access and enroll the first runner.
5. Add provider adapters and approval policies before remote infrastructure creation.
