import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';

const API_BASE_URL: string = (Constants.expoConfig?.extra as any)?.API_BASE_URL || 'http://127.0.0.1:8787';

export async function ensureDevice() {
  let deviceId = await AsyncStorage.getItem('deviceId');
  let deviceSecret = await AsyncStorage.getItem('deviceSecret');
  if (!deviceId || !deviceSecret) {
    const res = await fetch(`${API_BASE_URL}/device/register`, { method: 'POST' });
    if (!res.ok) throw new Error(`Device register failed: ${res.status}`);
    const j = await res.json();
    deviceId = j.deviceId;
    deviceSecret = j.secret;
    await AsyncStorage.multiSet([
      ['deviceId', deviceId],
      ['deviceSecret', deviceSecret],
    ]);
  }
  return { deviceId, deviceSecret } as { deviceId: string; deviceSecret: string };
}

export async function signedFetch(path: string, body: any) {
  const { deviceId, deviceSecret } = await ensureDevice();
  const ts = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify(body ?? {});
  const sig = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${deviceId}.${ts}.${payload}.${deviceSecret}`, { encoding: Crypto.CryptoEncoding.HEX });
  return fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-device-id': deviceId,
      'x-timestamp': String(ts),
      'x-signature': sig,
    },
    body: payload,
  });
}

