# Transcript filler markers

Live captions highlight recognized vocal fillers in red while recording.
The editor automatically derives red timeline markers from the saved transcript, including manual corrections.
Supported words are `um`, `umm`, `uh`, `uhh`, `erm`, `er`, and `hmm`, matched as whole words without changing transcript text.
Context-dependent words such as `like`, `so`, and `well` remain unmarked.

Tap a filler chip to review its source recording.
Clean previews map markers through the selected source segments, so removed speech has no marker in the output timeline.
Positions are proportional estimates within transcript segments because transcription does not supply exact word alignment.
Markers do not automatically delete audio.
Fillers omitted by transcription cannot be detected by this approach.

The former acoustic model, native inference bridge, manual analysis panel, and host benchmark have been removed.
No extra model download or analysis action is required.

Validation covers whole-word matching, punctuation, corrected text, invalid timing, source isolation, and clean timeline offsets.
