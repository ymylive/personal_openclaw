#!/usr/bin/env python3
import json
from pathlib import Path
import hashlib

REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = REPO_ROOT / "deployment" / "mcp_large_text_manifest.json"

def main():
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for entry in data.get("largeTextFiles", []):
        target = REPO_ROOT / entry["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        parts = []
        for rel in entry.get("chunks", []):
            parts.append((REPO_ROOT / rel).read_text(encoding="utf-8"))
        content = "".join(parts)
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if digest != entry.get("sha256"):
            raise SystemExit(f"sha256 mismatch for {entry['path']}: {digest} != {entry.get('sha256')}")
        target.write_text(content, encoding="utf-8")
        print(f"restored {entry['path']}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
