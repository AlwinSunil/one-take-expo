# Filler and gap review

The simplified editor shows the automatic edit as a timeline. Removed footage is greyed out. Tap a segment to preview its original range, then use Restore or Remove to change that decision. Video and audio use the same included ranges during preview and export; original recordings remain available.

Unambiguous vocal fillers such as `um`, `uh`, `erm`, and elongated variants receive filler labels. Context-dependent words such as `like`, `so`, and `well` stay ordinary speech. Caption corrections do not conceal a filler that remains in the recorded audio.

Mixed-sentence filler cuts require verified saved-audio word timing. Otherwise the estimated interval remains a suggestion for review. Standalone filler utterances can be removed automatically, with overlapping meaningful speech protected. Live word confidence alone does not establish precise timing, and saved recordings are refined offline when needed.

Gaps are based on measured quiet audio, with speech-edge padding and protection for verified spoken words. Audio without a transcript is labelled Audio, not a confirmed gap. Improved timing can restore speech mistakenly removed by an earlier automatic gap cut; explicit manual decisions remain unchanged.

Repeated equivalent deliveries are ranked by completeness, fillers, pace, available recognition confidence, and measured pauses. Uncertain matches and changed facts are preserved. Every automatic exclusion is reversible.

The source-timeline mapping and filler-removal helpers also preserve occurrence identity when a recording appears more than once in an edit. Their older dedicated filler-preview panel is not used by the simplified editor.
