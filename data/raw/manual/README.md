# Manually supplied raw data

Drop files here that cannot be fetched programmatically — typically Discord
attachments or other auth-gated downloads.

When you add a file:

1. Save it under a descriptive, lowercase name with the source date as suffix,
   e.g. `prohibited_library_mods_2026-04-29.json`.
2. Note its origin in `docs/sources.md` (the URL it came from).
3. Tell the assistant where it lives so it can be wired into the pipeline.

Files in this folder are never overwritten by `scripts/update-poe2-data.sh`.
