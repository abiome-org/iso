# Autoresearch coding-agent landscape

Snapshot: July 28, 2026.

The direct answer is yes: serious parallel-autoresearch systems exist, and two current systems are
genuinely close to the product category:

- [CORAL](https://github.com/Human-Agent-Society/CORAL), which treats multi-agent self-evolution as
  the primary loop. Give it a codebase and grader and it handles isolated workspaces, evaluation,
  persistent shared attempts/notes, and collaboration across several coding-agent runtimes. Its
  Claude Code/Codex plugin can turn a conversational optimization request into a task scaffold,
  construct a grader, validate the setup, and hand off a launch-ready run.
- [OpenResearch](https://github.com/alphaXiv/openresearch-cli), which combines a local agent
  conversation and dashboard with parallel worktrees, a git experiment tree, SQLite state, a
  JSON/SSE API, live logs/diffs/artifacts, and local or remote compute. Given a goal, its agent can
  autonomously propose, launch, and analyze experiments.

CORAL is closest to the autonomous multi-agent research engine. OpenResearch is closest to the local
operator product. This is not an empty category, and ISO should not be positioned as though no close
product exists. In the public material reviewed, the remaining distinction is the set of properties
enforced together inside one coding-agent harness: durable one-turn admission, a long-lived local
kernel, bounded promotion evidence, frozen post-selection trial plans, evaluator/candidate isolation,
at-least-once conversational progress delivery, and a first-class causal idea/evidence graph.

Other important systems cover narrower parts of the loop:

- [Karpathy's autoresearch](https://github.com/karpathy/autoresearch) establishes the minimal
  autonomous experiment loop: change code, train, measure, keep or revert, and record the result.
- [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) brings that loop into Pi as an
  extension, but remains a focused research loop rather than a vertically integrated agent,
  durable kernel, and operator product.
- [Revis](https://github.com/mu-hashmi/revis) is a deliberately harness-agnostic coordination layer:
  stable git refs, isolated clones, a daemon that relays commit summaries into agent sessions, and
  operator-selected promotion. It helps parallel autoresearch agents see and build on each other's
  work, but explicitly does not own orchestration, evaluation, or the agent harness.
- [autoresearch.studio](https://autoresearch.studio/) productizes a git-backed keep/discard loop with
  a live dashboard. [AutoResearch Cloud](https://research.frozo.ai/) adds cloud execution, SSE
  streaming, and parallel lanes around an explicit experiment specification.
- [The AI Scientist v2](https://github.com/SakanaAI/AI-Scientist-v2) automates scientific idea
  generation, experiments, analysis, and paper production. Its center of gravity is machine-learning
  research artifacts rather than a general-purpose coding-agent harness and live operator surface.
- [Meta SPDL autoresearch](https://facebookresearch.github.io/spdl/main/autoresearch/autoresearch.html)
  explores autonomous performance optimization inside a particular systems domain.
- [Claude Code subagents](https://code.claude.com/docs/en/agents) and the
  [Codex app](https://openai.com/index/introducing-the-codex-app/) make parallel coding agents a
  primary interaction pattern, but parallel work is not itself an evaluator-governed research
  campaign.
- [Agentree](https://agentree.app/) and [webmux](https://webmux.dev/) show the adjacent control-plane
  frontier: graphs, worktrees, live terminals, mobile chat, and agent orchestration. Their graph is
  principally a work/session graph rather than an evidence-tested hypothesis graph.
- [Factory Droid Computers](https://docs.factory.ai/cli/features/droid-computers) demonstrates the
  remote runner/control-room shape: work continues on managed or bring-your-own machines while the
  operator observes and directs it elsewhere.

ISO's product thesis is not “parallel agents do not exist.” It is a differentiated vertical
intersection:

1. one capability-restricted, repository-stable principal conversation, preceded by a durable
   objective receipt and an owned attempt lease, with an enforced durable outcome on the same turn;
2. a durable local kernel with correction/continuation recovery, a pause/stop admission barrier, and
   immutable source, dependency, evaluator, model, and budget identity before asynchronous work;
3. parallel Pi workers followed by exploratory screening and exactly one fresh post-selection
   replication opportunity per generation, with Bonferroni across the declared generation budget;
4. frozen opaque paired trial plans created only after the candidate commit is immutable and reused
   across retries;
5. a bounded Hoeffding family-wise claim only when finite score bounds and independent paired trials
   are valid, with an explicitly assumption-based paired Student-t path otherwise;
6. isolated detached evaluator/control roots that deny the mutable live repository;
7. at-least-once delivery of material progress into the principal conversation, acknowledged only
   after a completed agent turn;
8. git commits joined to a causal campaign → generation → idea → experiment → result → reflection
   graph, including negative results;
9. a live local control room, plus a specified—but not deployed—outbound-only authenticated
   remote-relay architecture.

That combination—not merely “multiple agents” or “an autoresearch loop”—is the product boundary.
The current product boundary is local: `iso.abiome.org`, Cloudflare Access, the edge command mailbox,
multi-user remote identity, and remote compute adapters remain architecture, not deployed features.
