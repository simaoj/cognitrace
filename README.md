

# Cognitrace

Cognitrace logs interactions with AI coding assistants — prompts and responses — into a structured JSON file inside your project.

[![Install on VS Code](https://img.shields.io/badge/Instalar%20no-VS%20Code-007ACC?logo=visual-studio-code&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=schardosim.cognitrace)

## Supported assistants

- **Claude Code** (VS Code extension and CLI)
- **GitHub Copilot Chat**
- **OpenAI Codex CLI**
- **Gemini/Antigravity**

## Enabling logging for a project

Logging is **off by default** for every project. To turn it on:

1. Click the Cognitrace icon in the Activity Bar (left-hand sidebar).
2. Click **Enable for this project**.

This writes `"cognitrace.enabled": true` to the workspace's `.vscode/settings.json`, so the choice is per-project and stored alongside the project itself. Use the same panel to disable logging again at any time.

## User identification

Every log entry is tagged with a `user_id` (see [Log format](#log-format)) that also determines which log file it lands in. From the Cognitrace panel in the Activity Bar, enter your **user code** — the identifier issued to you by the companion Cognitrace API; for a classroom deployment, this is typically your student number). It's required: entries are tagged `"unknown"` until you set one, and until it's set to a code the API recognizes, it won't authenticate for remote sync or project linking (see [Log destination](#log-destination)). Stored as `cognitrace.userIdManualCode` per-project in `.vscode/settings.json`.

## Log destination

Also from the Cognitrace panel, **Save locally** (on by default, `cognitrace.saveLocally`) controls whether each captured entry gets written to `.ai_log/` in this workspace.

Syncing to a Cognitrace ingest API isn't a separate toggle — it happens automatically, alongside local saving, the moment you set your [user code](#user-identification) above. There's nothing else to configure:

- The API's base URL isn't something you set in the panel — it's baked into the extension at
  package time from the `COGNITRACE_API_URL` environment variable present when it was built (see
  `webpack.config.js`), so every install of a given build already points at the same server. For a
  local build (`yarn compile`, `yarn watch`, `yarn package`), a `.env` file in the project root
  works too — it's loaded automatically and gitignored by default.
- Your **user code** doubles as the API key — there's no separate key to paste or store, and no
  way to sync without logging in with a code first. The same code that tags your entries also
  authenticates them, so syncing just works the moment you set one.
- Once a code is set, the panel shows a live **Connection** status — "Connected as ...", or an
  error naming what's wrong (no code yet, no URL baked into this build, or the server rejected the
  code) — so you can see it's working without doing anything. It rechecks automatically whenever
  you change the code.

A network failure, an unset user code, or a build with no URL baked in only logs a warning to the
Cognitrace output channel (or silently does nothing, for a build with no URL); it never blocks or
drops a local write.

## Project

Once your user code is verified, the Cognitrace panel shows a **Project** dropdown populated from
the projects linked to your account in the companion API. Pick which one this workspace's entries
should be tagged with — stored as `cognitrace.projectId` per-project in `.vscode/settings.json`. If
you have no projects linked yet (or leave this unset), entries are tagged with the project
auto-detected from this workspace folder instead.

Setting a user code doesn't just cover new activity — Cognitrace also backfills any entries already
sitting in `.ai_log/` from before it was set (or from before the API was reachable), so nothing
captured locally is left behind. This backfill resumes from wherever it last left off, so it's safe
to run repeatedly: it kicks in automatically whenever logging starts, and again whenever you change
your user code. It only has anything to backfill for entries that were actually saved locally, of
course — there's nothing to resume from history you chose not to keep.

## How it works

Once enabled, Cognitrace watches the session files that each AI assistant writes locally and captures every user message and assistant response — including, for Claude Code, which files it read and which file you had open or selected in the IDE when you sent a prompt. It also watches the VS Code integrated terminal (via the Shell Integration API) and captures every command that runs, its output, and whether it succeeded or failed. And it captures every file you save through the editor, so you have a record of file changes alongside the prompts that may (or may not) have prompted them. Logs are written to a `.ai_log/` folder at the root of your workspace.

## Log format

Each log file is named `prompt_log_YYYY-MM-DD_<user-id>.json` and contains an array of entries:

```json
[
  {
    "timestamp": "2025-04-12T10:32:00.000Z",
    "source": "claude",
    "session_id": "4f3a5a8f-3708-4b89-b646-a9653e2c45a9",
    "user_id": "dev-1",
    "call_context": {
      "cwd": "/Users/jane/projects/my-app"
    },
    "role": "user",
    "content": "refactor the auth module to use JWT"
  },
  {
    "timestamp": "2025-04-12T10:32:05.000Z",
    "source": "claude",
    "session_id": "4f3a5a8f-3708-4b89-b646-a9653e2c45a9",
    "user_id": "dev-1",
    "call_context": {
      "cwd": "/Users/jane/projects/my-app"
    },
    "role": "assistant",
    "content": "Here's the refactored auth module using JWT..."
  },
  {
    "timestamp": "2025-04-12T10:33:12.000Z",
    "source": "terminal",
    "session_id": "4f3a5a8f-3708-4b89-b646-a9653e2c45a9",
    "user_id": "dev-1",
    "call_context": {
      "cwd": "/Users/jane/projects/my-app"
    },
    "role": "terminal",
    "content": "$ npm test\n1 failing\nExpected 200, got 500",
    "exit_code": 1,
    "status": "error"
  },
  {
    "timestamp": "2025-04-12T10:34:01.000Z",
    "source": "file_change",
    "session_id": "4f3a5a8f-3708-4b89-b646-a9653e2c45a9",
    "user_id": "dev-1",
    "call_context": {
      "cwd": "/Users/jane/projects/my-app"
    },
    "role": "file_change",
    "content": "src/auth/jwt.ts"
  },
  {
    "timestamp": "2025-04-12T10:34:15.000Z",
    "source": "claude",
    "user_id": "dev-1",
    "call_context": {
      "cwd": "/Users/jane/projects/my-app"
    },
    "role": "context_file",
    "content": "/Users/jane/projects/my-app/src/auth/jwt.ts"
  }
]
```

| Field | Description |
|---|---|
| `timestamp` | ISO 8601 timestamp of when the message was captured |
| `source` | Which assistant produced the message (`claude`, `github_copilot`, `codex`, `antigravity`), or `terminal` for a shell command, or `file_change` for a saved file |
| `session_id` | The originating assistant session/conversation, derived from its transcript filename. Lets you tell apart entries from concurrent or interleaved sessions in the same daily log. `terminal` and `file_change` entries have no session of their own, so they're tagged with whichever AI session was most recently active in the workspace, as a best-effort correlation — absent if no AI session has produced an entry yet |
| `user_id` | Your [user code](#user-identification), or `"unknown"` if none is set yet |
| `call_context.cwd` | Absolute path of the workspace |
| `role` | `user` for prompts, `assistant` for AI responses, `terminal` for shell commands, `file_change` for saved files, `context_file` for a file that entered the AI's context |
| `content` | The message text; `$ <command>` plus its captured output (truncated past 4000 characters) for terminal entries; the file's path relative to the workspace for file-change entries; the absolute file path for context-file entries |
| `exit_code` | Terminal entries only — the command's exit code, if the shell reported one |
| `status` | Terminal entries only — `success`, `error`, or `unknown` (when no exit code was reported) |
| `project_id` | The linked [project](#project) this entry is tagged with, if one is set — absent otherwise |

File-change entries are captured from explicit editor saves (`Cmd/Ctrl+S`, or an extension calling `document.save()` on your behalf) — not from autosave (`files.autoSave: afterDelay` or `onFocusChange`), and not from files an AI CLI writes directly to disk, since those don't go through VS Code's save mechanism and already show up as tool calls in that assistant's own log entries.

Context-file entries are currently Claude Code only: one is logged whenever Claude reads a file with its `Read` tool, and whenever the IDE tells Claude which file you have open or which lines you've selected. Other assistants track context differently and aren't covered yet.

## Output channel

Open **View > Output** and select **Cognitrace** from the dropdown to see real-time diagnostic logs — which directories are being watched, which files are detected, and which messages are captured.

## Notes

- The `.ai_log/` folder is created automatically. Add it to `.gitignore` if you don't want logs committed.
- Logs are append-only and split by day and user id, so parallel sessions don't overwrite each other.
- By default, entries are saved locally only — nothing is sent anywhere over the network. See [Log destination](#log-destination) to opt into also syncing entries to a server.
