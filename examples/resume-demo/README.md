# Resume Demo Fixture

This example is a recorded local-only run of the harness. It proves the basic resume loop without requiring OpenClaw, Codex, Kimi, or network credentials.

Recorded flow:

```bash
node src/cli.js validate examples/resume-demo
node src/cli.js run examples/resume-demo --worker local-command
node src/cli.js evidence examples/resume-demo --type review-note --criterion-id demo-reviewed --status pass --summary "..."
node src/cli.js evidence examples/resume-demo --type handoff --status pass --summary "..."
node src/cli.js verify examples/resume-demo
node src/cli.js summary examples/resume-demo
```

The committed run log and evidence show:

- worker prompt generation
- local worker execution
- captured worker output
- checkpoint writes
- review evidence linked to a success criterion
- handoff evidence for resuming from the fixture
