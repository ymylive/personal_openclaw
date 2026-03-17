## Server Sync Notes

- Repository root is synced from the server's OpenClaw source tree based on the live server commit `1007d71f0cece18ca74d2a2bc7ab3b88c734f75e`.
- `workspace/` contains the custom runtime modules used on the server, filtered to keep code and assets while excluding runtime logs, state, caches, and private data.
- `deployment/openclaw.json.example` is a redacted example generated from the live server config.
- Exact live secrets and private JSON data are stored only in the local backup folder `E:\project\personal_openclaw_private_backup_20260317` and are not meant to be committed.
