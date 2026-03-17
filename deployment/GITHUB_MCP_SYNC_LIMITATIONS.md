# GitHub MCP Sync Limitations

- Uploaded through GitHub MCP.
- Binary files are omitted because MCP corrupts binary bytes.
- Large text files are stored as placeholders + chunks + restore script.
- Run `python deployment/restore_large_text_files.py` after cloning if you need the original large text files.

## GitHub Secret-Scan Placeholders

extensions/google-antigravity-auth/index.ts

