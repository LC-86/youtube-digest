# Domain Docs

Before exploring, read the root `CONTEXT.md` (or `CONTEXT-MAP.md` when present) and ADRs relevant to the work under `docs/adr/`. If they do not exist, proceed silently.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

Use the vocabulary in `CONTEXT.md` when naming domain concepts. If an output conflicts with an ADR, state the conflict explicitly rather than silently overriding it.
