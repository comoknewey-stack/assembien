# @assem/desktop

Desktop-facing chat shell for the ASSEM MVP.

This workspace now supports two modes:

- Web shell through Vite
- Native desktop shell through Tauri

The app remains intentionally thin: it renders chat state, privacy mode, permissions, and history, while the local agent keeps ownership of orchestration, persistence, routing, scheduler state and tool execution.

Useful commands from the repository root:

- `npm run dev:desktop`
- `npm run dev:desktop:app`
- `npm run build:desktop`
- `npm run doctor:desktop`

More detail lives in [../../docs/desktop-tauri.md](../../docs/desktop-tauri.md).
