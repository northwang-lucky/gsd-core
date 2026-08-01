---
type: Added
---
**Cline installs now emit per-command workflow stubs, so every `/gsd-*` command appears in the `/` autocomplete.** Cline's skill discovery scans only one directory level, so the nested `gsd-ns-*` member skills never show up in slash completion — only workflow files do (they default to enabled and are listed under "custom"). Each `workflows/gsd-<cmd>.md` stub is a thin delegator that points at the real member SKILL.md, so the skills stay the single source of truth and there is no duplicated command logic. Stubs follow the active profile (minimal installs emit only the 8 core commands), are hash-tracked in the manifest, and are removed on uninstall.
