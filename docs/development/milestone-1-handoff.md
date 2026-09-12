# Milestone 1 implementation handoff

Milestone 1 is GitHub **01 · Tier 0 — Record with coverage and a clean cut**, not the later Tier 1 feature set. Use [Milestone 0 evidence](milestone-0-status.md) to distinguish demonstrated research from remaining acceptance.

| Parallel lane | Start with | Integration boundary |
| --- | --- | --- |
| Capture and coaching | #11 recording reliability, #15 useful vision, #18 basic coaching | Keep camera controls familiar; one native owner coordinates camera frames and audio. Disable optional advice on unsupported/error/stale input; never stop recording because vision failed. |
| Script and speech | #12 editable spoken lines/actions, #13 offline speech, #16 coverage | Retain multi-line audio takes. Pending speech never means covered. Action cues remain separate from captions and recognized speech. |
| Storage and review | #14 compatible project persistence, #17 immediate cut review, #20 review/pickups | Preserve originals and legacy Project JSON. Immediate playback is separate from export. Apply a versioned extension only after shared handoffs are reviewed. |

Before combining speech and vision, resolve their native runtime versions: #8 used a custom ORT 1.28 build; the isolated #7 experiment used ORT 1.27 with QNN. Separate-APK success does not prove both can coexist in one app. Inspect native-library packaging and validate the selected combined build on iQOO.

The existing [sample runner](sample-sessions.md) supports independent UI work while engines integrate. Use the sample pending/missing/action/export-failure states for UX; do not present fixture outputs as real processing. Keep viewfinder advice optional, short, stable and outside recording controls. Preserve large-text layouts and accessible control names.

Later in this same milestone: integrate manual/remote overrides, wrap decisions, captioned export and project deletion through their existing issues. Run the complete Tier 0 scenario set and five consecutive integrated sessions before #34 acceptance. No research benchmark substitutes for that gate.
