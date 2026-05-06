import { useColorScheme } from 'react-native';

export interface ColorPalette {
  background: string;
  surface: string;
  text: string;
  textSecondary: string;
  muted: string;
  border: string;
  subtle: string;

  primary: string;
  primaryTint: string;
  accent: string;
  accentTint: string;

  danger: string;
  dangerTint: string;
  warning: string;
  warningTint: string;
  info: string;
  infoTint: string;
}

export const lightColors: ColorPalette = {
  background: '#FFFFFF',
  surface: '#F9FAFB',
  text: '#111111',
  textSecondary: '#6B7280',
  muted: '#6B7280',
  border: '#E5E7EB',
  subtle: '#F9FAFB',

  primary: '#1D9E75',
  primaryTint: '#E6F5EE',
  accent: '#1D9E75',
  accentTint: '#E6F5EE',

  danger: '#E24B4A',
  dangerTint: '#FCE7E7',
  warning: '#EF9F27',
  warningTint: '#FEF3C7',
  info: '#378ADD',
  infoTint: '#E1ECFB',
};

export const darkColors: ColorPalette = {
  background: '#0F0F10',
  surface: '#1A1A1C',
  text: '#F5F5F5',
  textSecondary: '#A3A3A8',
  muted: '#A3A3A8',
  border: '#2A2A2C',
  subtle: '#1A1A1C',

  primary: '#2EB489',
  primaryTint: '#1A3329',
  accent: '#2EB489',
  accentTint: '#1A3329',

  danger: '#F26361',
  dangerTint: '#3A1B1B',
  warning: '#F0A93B',
  warningTint: '#3A2A12',
  info: '#5BA0E5',
  infoTint: '#152A40',
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
