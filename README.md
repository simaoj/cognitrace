# Cognitrace

Cognitrace automatically logs all interactions with AI coding assistants — prompts and responses — into a structured JSON file inside your project. No configuration required.

## Supported assistants

- **Claude Code** (VS Code extension and CLI)
- **GitHub Copilot Chat**
- **OpenAI Codex CLI**

## How it works

When activated, Cognitrace watches the session files that each AI assistant writes locally and captures every user message and assistant response. Logs are written to a `.ai_log/` folder at the root of your workspace.

## Log format

Each log file is named `prompt_log_YYYY-MM-DD_<git-username>.json` and contains an array of entries:

```json
[
  {
    "timestamp": "2025-04-12T10:32:00.000Z",
    "source": "claude",
    "git_branch": "main",
    "git_user_name": "Jane Doe",
    "call_context": {
      "cwd": "/Users/jane/projects/my-app"
    },
    "role": "user",
    "content": "refactor the auth module to use JWT"
  },
  {
    "timestamp": "2025-04-12T10:32:05.000Z",
    "source": "claude",
    "git_branch": "main",
    "git_user_name": "Jane Doe",
    "call_context": {
      "cwd": "/Users/jane/projects/my-app"
    },
    "role": "assistant",
    "content": "Here's the refactored auth module using JWT..."
  }
]
```

| Field | Description |
|---|---|
| `timestamp` | ISO 8601 timestamp of when the message was captured |
| `source` | Which assistant produced the message (`claude`, `github_copilot`, `codex`) |
| `git_branch` | Active git branch at the time of the interaction |
| `git_user_name` | Git user name from the workspace config |
| `call_context.cwd` | Absolute path of the workspace |
| `role` | `user` for prompts, `assistant` for AI responses |
| `content` | The message text |

## Output channel

Open **View > Output** and select **Cognitrace** from the dropdown to see real-time diagnostic logs — which directories are being watched, which files are detected, and which messages are captured.

## Notes

- The `.ai_log/` folder is created automatically. Add it to `.gitignore` if you don't want logs committed.
- Logs are append-only and split by day and git user, so parallel sessions don't overwrite each other.
- No data is sent anywhere. Everything stays on disk, locally.
