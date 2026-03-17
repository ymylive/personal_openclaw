# GitHub MCP Sync Limitations

- This repository was synchronized through GitHub MCP file-write tools.
- GitHub MCP preserves text correctly, but it does not preserve binary bytes faithfully.
- Large text files also exceed the MCP payload ceiling when uploaded whole.

## What Was Stored

- Normal text/code files were uploaded directly.
- Large text/code files were stored as:
  - a small placeholder at the original path
  - chunk files under `deployment/mcp_large_text_chunks/`
  - a manifest at `deployment/mcp_large_text_manifest.json`
  - a restore script at `deployment/restore_large_text_files.py`
- Binary files were not uploaded to GitHub and are listed in `deployment/GITHUB_MCP_OMITTED_BINARIES.txt`.

## Restore Large Text Files

```bash
python deployment/restore_large_text_files.py
```

## Full Local Snapshot

The full original server snapshot, including omitted binaries and private config backups, remains in the maintainer's local backup.
