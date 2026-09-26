// The ONE place the scan-consent wording lives. Rendered by
// app/scan-consent.tsx (both the first-run gate and the Settings info view)
// and used for the Settings row label and the modal's header title.
// Nothing here is firm-specific; the same text ships to every tenant.
//
// If this copy changes in substance (what is sent, to whom, what is kept),
// re-verify it against services/ai/scanner.ts and app/(tabs)/scan.tsx
// before shipping — the text is a factual description of that code.
//
// Known nuance behind "doesn't save it": the app never writes the photo to
// its database or preferences, and the in-memory copy is cleared when the
// flow ends. The camera, the photo picker and the image resizer do write a
// temporary copy into the app's own cache directory, which iOS clears on
// its own schedule; a follow-up will delete those files explicitly.

export const SCAN_CONSENT_TITLE = 'Your photo goes to an AI service';

export const SCAN_CONSENT_BODY =
  "To read your handwritten notes, Jot sends the photo to Anthropic, the company that makes Claude, and gets back the entries it finds. Your project list is sent with it so the entries can be matched. The photo is used only for that. Jot doesn't save it or send it anywhere else. Manual entries go only to BQE Core.";

/** Settings row label and the consent modal's header title. */
export const SCAN_CONSENT_SETTINGS_LABEL = 'How scanning works';

export const SCAN_CONSENT_CONTINUE_LABEL = 'Continue';
export const SCAN_CONSENT_NOT_NOW_LABEL = 'Not now';
export const SCAN_CONSENT_DONE_LABEL = 'Done';
