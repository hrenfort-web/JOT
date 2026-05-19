import { create } from 'zustand';
import type { ParsedFlag, ParsedTimesheet } from '../services/ai/scanner';

export interface CapturedImage {
  base64: string;
  width: number;
  height: number;
  source: 'camera' | 'library';
  capturedAt: number;
}

/**
 * Row in the scan review screen's editable list. Hoisted here from
 * app/scan/review.tsx so the in-memory draft slot below can hold it without
 * pulling a screen-file type into the store layer. Shape is unchanged from
 * the original local definition; consumers re-import from this module.
 */
export interface ReviewEntry {
  id: string;
  day: string;
  projectId: string | null;
  phaseProjectId: string | null;
  hours: number;
  memo: string;
  flag: ParsedFlag | null;
  source: 'parsed' | 'manual';
  // BQE rejection message captured from the per-entry fallback in
  // submitParsedBatch. null on a fresh entry; populated after a partial-
  // submit pass when the BQE call rejected this specific row. Cleared when
  // the user edits the entry (any field change indicates they're addressing
  // the rejection).
  submitError: string | null;
  // LocalTimeEntry id for this entry's last failed-submit attempt. Used
  // when the user taps "Retry failed" so submitParsedBatch can clean up
  // the stale failed SQLite row before reinserting. null = never attempted
  // yet (don't pass to the dedupe path).
  lastLocalId: number | null;
}

interface ScanState {
  captured: CapturedImage | null;
  parsed: ParsedTimesheet | null;
  // In-memory draft for the review screen. null = no draft; non-null array
  // means the user has been editing and we should restore their edits on
  // re-mount instead of regenerating from `parsed`. Single-slot (not keyed)
  // because there's only ever one in-flight scan at a time. Cleared via
  // clearAll() on submit success.
  reviewEntries: ReviewEntry[] | null;
  setCaptured: (image: CapturedImage) => void;
  setParsed: (parsed: ParsedTimesheet | null) => void;
  setReviewEntries: (entries: ReviewEntry[]) => void;
  clearCaptured: () => void;
  clearAll: () => void;
}

export const useScanStore = create<ScanState>((set) => ({
  captured: null,
  parsed: null,
  reviewEntries: null,
  setCaptured: (image) => set({ captured: image, parsed: null, reviewEntries: null }),
  setParsed: (parsed) => set({ parsed }),
  setReviewEntries: (entries) => set({ reviewEntries: entries }),
  clearCaptured: () => set({ captured: null }),
  clearAll: () => set({ captured: null, parsed: null, reviewEntries: null }),
}));
