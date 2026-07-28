# ISO

ISO turns the Pi coding-agent harness into a parallel autoresearch system. The research loop is the
product's top-level primitive:

1. A read-only director inspects the repository and proposes falsifiable, diverse hypotheses.
2. Pi coding agents implement those hypotheses concurrently in isolated git worktrees.
3. A repository-owned evaluator returns a deterministic numeric score.
4. ISO commits each experiment branch and records ideas, failures, measurements, and ancestry.
5. The dashboard exposes the graph, active workers, pause/resume, steering, and abort controls.

## Quick start

From a git repository:

```bash
iso init \
  --goal "Reduce p95 latency without reducing test coverage" \
  --metric "p95_ms" \
  --direction minimize \
  --eval "npm run benchmark:iso" \
  --workers 4 \
  --iterations 3

iso serve --run
```

Open `http://127.0.0.1:4010`. Model credentials and defaults are inherited from Pi.

The evaluator must exit successfully and print a final JSON result:

```text
ISO_RESULT {"score": 41.2, "metrics":{"coverage":92.4},"summary":"optional"}
```

The dashboard intentionally binds to loopback by default. See
[`../../docs/iso-architecture.md`](../../docs/iso-architecture.md) before exposing control remotely.
