# knowledge/

Domain documents the agent grounds on. This directory is DATA — drop files here;
do not write code.

## Walk this

1. Drop your real domain docs in here as `.md` / `.txt` / `.json` (regulation,
   product sheets, provider lists, playbooks). One topic per file. Subdirectories
   are fine.
2. Register external research sources (URLs, regulation feeds, integration refs)
   in `agent.config.ts` under `knowledge.sources` — those are what the acquisition
   loop reads on top of these local files.
3. Run `pnpm knowledge:ingest` to enumerate inputs (DRY) and, once a model-backed
   driver is wired, drive the acquisition loop (`--run`).

## What gates what

- The files here + `knowledge.sources` feed the BUILD loop (acquire grounded
  knowledge). See KNOWLEDGE.md.
- `knowledge.requirements` in `agent.config.ts` is the ACT gate — what the agent
  must KNOW before it's allowed to propose. Scored from live workspace state.

Do not commit secrets. Knowledge is content, not credentials.
