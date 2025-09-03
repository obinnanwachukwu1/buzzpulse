import Constants from 'expo-constants';

// Optional share URL; configurable via app.json -> expo.extra.SHARE_URL
export const SHARE_URL: string | undefined =
  (Constants.expoConfig?.extra as any)?.SHARE_URL || undefined;

