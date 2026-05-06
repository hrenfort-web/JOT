import type { Ionicons } from '@expo/vector-icons';

export interface PhaseMeta {
  code: string;
  name: string;
  icon: keyof typeof Ionicons.glyphMap;
}

const KNOWN: Record<string, Omit<PhaseMeta, 'code'>> = {
  PA: { name: 'Pre-Application', icon: 'compass-outline' },
  SD: { name: 'Schematic Design', icon: 'pencil-outline' },
  DD: { name: 'Design Development', icon: 'resize-outline' },
  CD: { name: 'Construction Docs', icon: 'document-text-outline' },
  CA: { name: 'Construction Admin', icon: 'business-outline' },
  PM: { name: 'Project Mgmt', icon: 'briefcase-outline' },
  MTG: { name: 'Meetings', icon: 'people-outline' },
  ADM: { name: 'Admin', icon: 'settings-outline' },
};

export function phaseMeta(code: string | null, fallbackName?: string | null): PhaseMeta {
  if (!code) {
    return {
      code: '·',
      name: fallbackName ?? 'Other',
      icon: 'ellipsis-horizontal-outline',
    };
  }
  const upper = code.toUpperCase();
  const known = KNOWN[upper];
  if (known) return { code: upper, ...known };
  return {
    code: upper,
    name: fallbackName ?? upper,
    icon: 'ellipsis-horizontal-outline',
  };
}
