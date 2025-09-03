import { DynamicColorIOS, PlatformColor, Platform } from 'react-native';

export const colors = {
  background: Platform.select({
    ios: DynamicColorIOS({ light: 'systemBackgroundColor', dark: 'systemBackgroundColor' }) as any,
    default: '#FFFFFF',
  }),
  secondaryBackground: Platform.select({
    ios: DynamicColorIOS({ light: 'secondarySystemBackgroundColor', dark: 'secondarySystemBackgroundColor' }) as any,
    default: '#F6F7FB',
  }),
  label: Platform.select({
    ios: PlatformColor('label'),
    default: '#111111',
  }) as any,
  secondaryLabel: Platform.select({
    ios: PlatformColor('secondaryLabel'),
    default: '#666666',
  }) as any,
  separator: Platform.select({
    ios: PlatformColor('separator'),
    default: '#E5E5EA',
  }) as any,
  tint: Platform.select({
    ios: PlatformColor('tintColor'),
    default: '#0A84FF',
  }) as any,
};

export const radius = {
  card: 14,
  pill: 22,
};

