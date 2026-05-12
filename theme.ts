import { useColorScheme } from 'react-native';

// ---------------------------------------------------------------------------
// Theme B — cream + burnt orange.
//
// Replaces the prior green-on-soft-white iOS palette. Design goals:
//   - Background reads as paper, not screen (warm cream #FAF6EE)
//   - Surfaces lift via a subtler cream tone (#FFFCF5), not pure white
//   - One accent (#C75D2C burnt orange) carries every positive state —
//     submit, "logged" pills, today's-day marker, FAB, active tab. There
//     is no separate "success" colour; the accent IS positive.
//   - Empty states are NEUTRAL (cream surfaces), never pink/red. The data
//     is the celebration, not the chrome.
//
// Dark-mode palette is left in place for compile compatibility (a couple
// of screens still reference darkColors via useColors()). It still uses
// the old green tokens — we'll port it to Theme B in a follow-up after
// the light surfaces ship.
// ---------------------------------------------------------------------------

export interface ColorPalette {
  background: string;
  surface: string;
  text: string;
  textSecondary: string;
  // Mutest tone for hints/captions. Distinct from textSecondary —
  // textSecondary reads as "supporting copy", textTertiary as "data when
  // there is none / disabled label".
  textTertiary: string;
  muted: string;
  border: string;
  borderSubtle: string;
  subtle: string;

  primary: string;
  primaryTint: string;
  accent: string;
  accentTint: string;
  accentPressed: string;

  // Brand-only secondary, still terracotta. Kept as a separate token so
  // existing call sites (e.g. login tagline) don't break, but Theme B
  // collapses most secondary uses into the accent.
  secondary: string;
  secondaryTint: string;

  danger: string;
  dangerTint: string;
  warning: string;
  warningTint: string;
  info: string;
  infoTint: string;

  disabledBg: string;
  disabledText: string;
}

export const lightColors: ColorPalette = {
  background: '#FAF6EE',
  surface: '#FFFCF5',
  text: '#1A1A1A',
  textSecondary: '#5C5C5A',
  textTertiary: '#8A877F',
  muted: '#8A877F',
  // Border tokens: borderSubtle is the rgba 8% black for cards that need
  // a hairline they can almost ignore; border is the visible cream-tan
  // line for divisions that should be felt.
  border: '#E8E2D5',
  borderSubtle: 'rgba(0,0,0,0.08)',
  subtle: '#F0E2D5',

  // Theme B routes both `primary` and `accent` to the burnt orange so
  // existing call sites work without auditing every reference. The two
  // tokens are kept distinct in the type for future-proofing if we ever
  // want a separate primary CTA tone (e.g. brand colour for the wordmark
  // accent vs. interactive elements). Today they collapse to one.
  primary: '#C75D2C',
  primaryTint: '#F0E2D5',
  accent: '#C75D2C',
  accentTint: '#F0E2D5',
  accentPressed: '#A04D24',

  secondary: '#B06840',
  secondaryTint: '#F8E9E0',

  // Danger is warm deep red — sits with the cream tones better than the
  // bright #E24B4A from the prior palette.
  danger: '#A0392B',
  dangerTint: '#F0D9D2',
  // Warning + info kept similar to before; only the accent palette was
  // reimagined. These rarely surface and their hue space is already warm.
  warning: '#EF9F27',
  warningTint: '#FEF3C7',
  info: '#378ADD',
  infoTint: '#E1ECFB',

  disabledBg: '#EDE9DD',
  disabledText: '#B8B4A8',
};

// Legacy dark palette — Theme B port is TODO. Kept in tact so screens
// reading useColors() in dark mode don't break compile/render. Most
// production usage is light mode today.
export const darkColors: ColorPalette = {
  background: '#0F0F10',
  surface: '#1A1A1C',
  text: '#F5F5F5',
  textSecondary: '#A3A3A8',
  textTertiary: '#A3A3A8',
  muted: '#A3A3A8',
  border: '#2A2A2C',
  borderSubtle: 'rgba(255,255,255,0.08)',
  subtle: '#1A1A1C',

  primary: '#C75D2C',
  primaryTint: '#3A1F12',
  accent: '#C75D2C',
  accentTint: '#3A1F12',
  accentPressed: '#A04D24',

  secondary: '#C47856',
  secondaryTint: '#3A2418',

  danger: '#C75351',
  dangerTint: '#3A1B1B',
  warning: '#F0A93B',
  warningTint: '#3A2A12',
  info: '#5BA0E5',
  infoTint: '#152A40',

  disabledBg: '#2A2A2C',
  disabledText: '#5C5C5A',
};

export const colors: ColorPalette = lightColors;

export function useColors(): ColorPalette {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkColors : lightColors;
}

export const typography = {
  header: { fontSize: 18, fontWeight: '500' as const },
  body: { fontSize: 14, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
  largeNumber: { fontSize: 48, fontWeight: '500' as const },
} as const;

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------
//
// FONT_HANDWRITING is the name we register Architects Daughter under via
// expo-font + @expo-google-fonts/architects-daughter. Screens reference it
// by this constant rather than the literal string so a future font swap
// (e.g. Caveat, Shadows Into Light) is one edit, not a project-wide grep.
//
// The font MUST be loaded via useFonts in app/_layout.tsx before any
// component that uses it renders — otherwise the first wordmark paints
// in a system font, then flickers when the font arrives. Splash screen
// stays up until useFonts resolves.

export const FONT_HANDWRITING = 'ArchitectsDaughter_400Regular';
