import { create } from 'zustand';
import type { ParsedTimesheet } from '../services/ai/scanner';

export interface CapturedImage {
  base64: string;
  width: number;
  height: number;
  source: 'camera' | 'library';
  capturedAt: number;
}

interface ScanState {
  captured: CapturedImage | null;
  parsed: ParsedTimesheet | null;
  setCaptured: (image: CapturedImage) => void;
  setParsed: (parsed: ParsedTimesheet | null) => void;
  clearCaptured: () => void;
  clearAll: () => void;
}

export const useScanStore = create<ScanState>((set) => ({
  captured: null,
  parsed: null,
  setCaptured: (image) => set({ captured: image, parsed: null }),
  setParsed: (parsed) => set({ parsed }),
  clearCaptured: () => set({ captured: null }),
  clearAll: () => set({ captured: null, parsed: null }),
}));
