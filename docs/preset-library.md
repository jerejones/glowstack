# Preset library

The **Presets** tab at `/presets` creates, edits, duplicates, deletes, searches,
and pins presets. The editor uses the effect's normal controls and keeps a
local draft until Save. Pins are shared by all clients and survive restarts.
Looks displays pinned presets directly and other presets under **More presets**.

Library saves and deletes preserve existing live and preview looks: affected
layers are expanded to their old effect and parameters with their display name,
ID, seed, timing, and fade state retained. Applying a preset again uses the new
saved version. A failed validation/reload leaves the saved file and looks alone.

The UI uses the existing preset endpoints with `?library=true` on PUT and
DELETE. This permits overriding a configured preset in the writable data folder
and deleting it from the effective library without modifying mounted config.
Without this query flag, the original CLI/API behavior remains: configured
presets are read-only, edits affect referencing layers, and deleting an override
reveals the configured preset again.

`PUT /api/v1/presets/{id}` accepts optional `pinned` along with the existing
name/effect/params fields. `PATCH /api/v1/presets/{id}/pin` accepts only
`{"pinned":true}` or `{"pinned":false}`. GET preset responses include `pinned`.

`presets.saved.yaml` now also stores `pins` (ID to boolean) and `hidden` (IDs
removed through the library). Saving a hidden ID restores it. Pinning does not
copy or rewrite the preset's definition. Before downgrading to a release without
these fields, restore the matching saved-presets backup as well as the binary.

The map compares the original geometry payload, excluding its generation and preset names, on
config reload. A library-only change refreshes the preset catalog in place;
layout changes still reload the page. Existing drafts remain open when another
client changes the library.
