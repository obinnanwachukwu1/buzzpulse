import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState, createContext, useContext } from 'react';
import { Button, StyleSheet, Text, View, Modal, Platform, ScrollView, Pressable, Animated, PanResponder, Dimensions, Switch } from 'react-native';
import MapView, { Circle, Polygon, MapViewProps, PROVIDER_DEFAULT, Region, MapType, MapPressEvent } from 'react-native-maps';
import { NavigationContainer } from '@react-navigation/native';
import Constants from 'expo-constants';
// Prefer native iOS tabs when available; gracefully fall back in Expo Go or if not linked
let createBottomTabNavigator: ReturnType<typeof require>;
try {
  const canUseNative = Platform.OS === 'ios' && Constants.appOwnership !== 'expo';
  if (canUseNative) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    createBottomTabNavigator = require('@bottom-tabs/react-navigation').createNativeBottomTabNavigator;
  }
} catch {}
if (!createBottomTabNavigator) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  createBottomTabNavigator = require('@react-navigation/bottom-tabs').createBottomTabNavigator;
}
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { BlurView } from 'expo-blur';
import { colors, radius } from './src/theme';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { Accelerometer } from 'expo-sensors';
import { fetchHeat, HeatPoint } from './src/lib/api';
import { ingestHit } from './src/lib/ingest';
import campusMask from './assets/masks/campus.json';
import { extractPolygons, pointInPolygon } from './src/lib/pip';
import { BUILDINGS, findNearestBuilding, findBuildingForPoint } from './src/lib/buildings';
import LeafletMap from './src/components/LeafletMap';
import { fetchStats } from './src/lib/api';

function haversineMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const sinDLat = Math.sin(dLat / 2), sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const SettingsContext = createContext<{ showStats: boolean; setShowStats: (v: boolean) => void }>({ showStats: false, setShowStats: () => {} });

function MapScreen() {
  const mapRef = useRef<MapView>(null);
  const insets = useSafeAreaInsets();
  const { showStats } = useContext(SettingsContext);
  const [region, setRegion] = useState<Region | null>(null);
  const [heat, setHeat] = useState<HeatPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pulsing, setPulsing] = useState(false);
  const [pulseCount, setPulseCount] = useState(0);
  const [lastUpload, setLastUpload] = useState<string | null>(null);
  const pulseTimer = useRef<NodeJS.Timer | null>(null);
  const [droppedCount, setDroppedCount] = useState(0);
  // Always limit to zones; map type fixed
  const [mapType] = useState<MapType>('standard');
  const [selectedBuilding, setSelectedBuilding] = useState<{ id: string; name: string } | null>(null);
  const [selectedStats, setSelectedStats] = useState<any>(null);
  const SELECT_DISTANCE_M = 80;
  const windowH = Dimensions.get('window').height;
  const SHEET_H = Math.round(windowH * 0.6);
  const sheetTranslateY = useRef(new Animated.Value(SHEET_H)).current;
  const closeSheet = () => {
    Animated.timing(sheetTranslateY, { toValue: SHEET_H, duration: 200, useNativeDriver: true }).start(() => {
      setSelectedBuilding(null);
      setSelectedStats(null);
    });
  };
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 5,
      onPanResponderMove: (_e, g) => {
        const ty = Math.max(0, Math.min(SHEET_H, g.dy));
        sheetTranslateY.setValue(ty);
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > SHEET_H * 0.25 || g.vy > 0.75) closeSheet();
        else Animated.spring(sheetTranslateY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
      },
    })
  ).current;

  const campusPolys = useMemo(() => extractPolygons(campusMask), []);
  const campusPolysLatLng = useMemo(() =>
    campusPolys.map((poly) => poly.map(([lng, lat]) => ({ latitude: lat, longitude: lng }))),
    [campusPolys]
  );

  // Ensure device auth and notifications permission
  useEffect(() => {
    (async () => {
      try {
        const { ensureDevice } = await import('./src/lib/auth');
        await ensureDevice();
        await Notifications.requestPermissionsAsync();
      } catch {}
    })();
  }, []);

  // Default: a campus-ish location (Stanford Main Quad)
  const defaultRegion: Region = useMemo(
    () => ({ latitude: 37.4275, longitude: -122.1697, latitudeDelta: 0.02, longitudeDelta: 0.02 }),
    []
  );

  useEffect(() => {
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          setRegion({
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
            latitudeDelta: 0.02,
            longitudeDelta: 0.02,
          });
          // Auto-start tracking on app start when permission is granted
          try { await startPulse(); } catch {}
        } else {
          setRegion(defaultRegion);
        }
      } catch {
        setRegion(defaultRegion);
      }
    })();
  }, [defaultRegion]);

  const onRegionChangeComplete: MapViewProps['onRegionChangeComplete'] = (r) => {
    setRegion(r);
  };

  const refreshHeat = async () => {
    if (!region) return;
    setLoading(true);
    setError(null);
    try {
      const west = region.longitude - region.longitudeDelta / 2;
      const east = region.longitude + region.longitudeDelta / 2;
      const south = region.latitude - region.latitudeDelta / 2;
      const north = region.latitude + region.latitudeDelta / 2;
      const data = await fetchHeat([west, south, east, north], { min: 1, window: 30 });
      setHeat(data);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleSelectBuilding = async (id: string, name: string) => {
    setSelectedBuilding({ id, name });
    setSelectedStats(null);
    try {
      // Nudge presence to update immediately upon selection
      try { await sampleAndSend(); } catch {}
      const stats = await fetchStats(`b:${id}`);
      setSelectedStats(stats);
    } catch (e: any) {
      setSelectedStats({ error: e?.message ?? String(e) });
    }
  };

  const startPulse = async () => {
    if (pulsing) return;
    setPulsing(true);
    // Fire immediately once, then interval
    await sampleAndSend();
    pulseTimer.current = setInterval(sampleAndSend, 60 * 1000);
  };

  const stopPulse = () => {
    setPulsing(false);
    if (pulseTimer.current) {
      clearInterval(pulseTimer.current);
      pulseTimer.current = null;
    }
  };

  // Motion-aware sampling
  const lastMoveRef = useRef<number>(Date.now());
  useEffect(() => {
    Accelerometer.setUpdateInterval(1000);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      const mag = Math.sqrt(x * x + y * y + z * z);
      if (Math.abs(mag - 1) > 0.04) lastMoveRef.current = Date.now();
    });
    return () => sub && sub.remove();
  }, []);

  const sampleAndSend = async () => {
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = loc.coords;
      const pt: [number, number] = [longitude, latitude];

      // Motion-aware gating (skip if driving fast)
      const speed = typeof loc.coords.speed === 'number' ? loc.coords.speed : 0;
      const driving = speed > 8;
      if (driving) {
        setDroppedCount((c) => c + 1);
        return;
      }

      // Include-only: if we have campus polygons, drop points outside them
      if (campusPolys.length > 0) {
        const inCampus = campusPolys.some((poly) => pointInPolygon(pt, poly));
        if (!inCampus) {
          setDroppedCount((c) => c + 1);
          return; // do not send
        }
      }

      // Prefer polygon containment, else nearest within 100m
      const b = findBuildingForPoint(latitude, longitude, 100) || findNearestBuilding(latitude, longitude);
      if (!b) {
        setDroppedCount((c) => c + 1);
        return;
      }
      const cellId = `b:${b.id}`;
      const ts = Math.floor(Date.now() / 1000);
      const resp = await ingestHit(cellId, ts);
      setPulseCount((c) => c + 1);
      setLastUpload(new Date().toLocaleTimeString());

      // Hot-cell alerts (threshold 12, cooldown 30m per building)
      try {
        const presence = Number((resp as any)?.presence ?? 0);
        if (presence >= 5) {
          const key = `alert:last:${b.id}`;
          const last = await AsyncStorage.getItem(key);
          const now = Date.now();
          if (!last || now - Number(last) > 30 * 60 * 1000) {
            await Notifications.scheduleNotificationAsync({ content: { title: 'Hot spot nearby', body: `${b.name} is heating up` }, trigger: null });
            await AsyncStorage.setItem(key, String(now));
          }
        }
      } catch {}
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  useEffect(() => {
    return () => {
      if (pulseTimer.current) clearInterval(pulseTimer.current);
    };
  }, []);

  useEffect(() => {
    // Fetch once on mount/region ready
    if (region) refreshHeat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [region?.latitude, region?.longitude, region?.latitudeDelta, region?.longitudeDelta]);

  // Animate sheet when opening
  useEffect(() => {
    if (selectedBuilding) {
      sheetTranslateY.setValue(SHEET_H);
      Animated.timing(sheetTranslateY, { toValue: 0, duration: 220, useNativeDriver: true }).start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBuilding]);

  // Auto-refresh heat periodically
  useEffect(() => {
    const t = setInterval(() => void refreshHeat(), 30000);
    return () => clearInterval(t);
  }, [region?.latitude, region?.longitude, region?.latitudeDelta, region?.longitudeDelta]);

  return (
    <SafeAreaView style={styles.container}>
      {region && Platform.OS !== 'android' && (
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          provider={PROVIDER_DEFAULT}
          initialRegion={region}
          mapType={mapType}
          onRegionChangeComplete={onRegionChangeComplete}
          onPress={async (e: MapPressEvent) => {
            const { latitude, longitude } = e.nativeEvent.coordinate;
            const b = findBuildingForPoint(latitude, longitude, 100) || findNearestBuilding(latitude, longitude);
            if (!b) return;
            const d = haversineMeters({ latitude, longitude }, b.center);
            if (d <= SELECT_DISTANCE_M) { await Haptics.selectionAsync(); handleSelectBuilding(b.id, b.name); }
          }}
        >
          {BUILDINGS.map((b) => (
            <Polygon
              key={`b-${b.id}`}
              coordinates={b.polygon}
              strokeColor={'transparent'}
              strokeWidth={0}
              fillColor={'transparent'}
              tappable
              onPress={() => handleSelectBuilding(b.id, b.name)}
            />
          ))}

          {selectedBuilding && (() => {
            const b = BUILDINGS.find(x => x.id === selectedBuilding.id);
            if (!b) return null as any;
            return (
              <Polygon
                key={`b-highlight-${b.id}`}
                coordinates={b.polygon}
                strokeColor="#ff6600"
                strokeWidth={3}
                fillColor="rgba(255,165,0,0.15)"
              />
            );
          })()}
          {heat.map((h, idx) => (
            <Circle
              key={`${h.lat},${h.lng}-${idx}`}
              center={{ latitude: h.lat, longitude: h.lng }}
              radius={h.radius}
              strokeColor="rgba(255,0,0,0.35)"
              fillColor="rgba(255,0,0,0.2)"
            />
          ))}
        </MapView>
      )}
      {region && Platform.OS === 'android' && (
        <LeafletMap
          region={region}
          heat={heat}
          onTap={async (latitude, longitude) => {
            const b = findBuildingForPoint(latitude, longitude, 100) || findNearestBuilding(latitude, longitude);
            if (!b) return;
            const d = haversineMeters({ latitude, longitude }, b.center);
            if (d <= SELECT_DISTANCE_M) { await Haptics.selectionAsync(); handleSelectBuilding(b.id, b.name); }
          }}
        />
      )}
      <BlurView intensity={50} tint={Platform.OS === 'ios' ? ('systemChromeMaterial' as any) : 'light'} style={[styles.topBar, { top: insets.top + 8 }] }>
        <Text style={styles.title}>BuzzPulse</Text>
        <Pressable
          onPress={async () => { if (pulsing) { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); stopPulse(); } else { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); startPulse(); } }}
          style={({ pressed }) => [styles.pillBtn, { opacity: pressed ? 0.9 : 1 }]}
        >
          <Ionicons name={pulsing ? 'pause' : 'play'} size={16} color={'#fff'} />
          <Text style={styles.pillBtnText}>{pulsing ? 'Stop' : 'Start'}</Text>
        </Pressable>
      </BlurView>
      {showStats && (
        <BlurView intensity={40} tint={Platform.OS === 'ios' ? ('systemThinMaterial' as any) : 'light'} style={[styles.status, { bottom: insets.bottom + 8 }] }>
          <Text style={styles.statusText}>Pulses sent: {pulseCount}</Text>
          <Text style={styles.statusText}>Dropped: {droppedCount}</Text>
          <Text style={styles.statusText}>Last: {lastUpload ?? '—'}</Text>
        </BlurView>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Modal
        visible={!!selectedBuilding}
        animationType="none"
        transparent
        onRequestClose={closeSheet}
      >
        <View style={styles.modalRoot}>
          <Pressable style={styles.overlay} onPress={closeSheet} />
          <Animated.View style={[styles.sheetContainer, { transform: [{ translateY: sheetTranslateY }] }] }>
            <View style={styles.dragBar} {...panResponder.panHandlers} />
            <ScrollView contentContainerStyle={styles.sheetContent}>
              {selectedBuilding && (
                <View>
                  <Text style={styles.sheetTitle}>{selectedBuilding.name}</Text>
              {selectedStats ? (
                <>
                  <View style={styles.statsGrid}>
                    <View style={styles.statCard}>
                      <Text style={styles.statValue}>{(selectedStats.currentScore ?? 0).toFixed?.(2) ?? selectedStats.currentScore}</Text>
                      <Text style={styles.statLabel}>Score</Text>
                    </View>
                        <View style={styles.statCard}>
                          <Text style={styles.statValue}>{selectedStats.lastHourHits ?? 0}</Text>
                          <Text style={styles.statLabel}>Hits (1h)</Text>
                        </View>
                        <View style={styles.statCard}>
                          <Text style={styles.statValue}>{Number(selectedStats.typicalHourAvgHits7d ?? 0).toFixed(1)}</Text>
                          <Text style={styles.statLabel}>Typical (7d avg)</Text>
                        </View>
                        <View style={styles.statCard}>
                          <Text style={styles.statValue}>{(selectedStats.deltaVsTypical > 0 ? '+' : '') + Number(selectedStats.deltaVsTypical ?? 0).toFixed(1)}</Text>
                      <Text style={styles.statLabel}>Δ vs typical</Text>
                    </View>
                  </View>
                  {/* Vibes row */}
                  {selectedStats?.vibesLastHour && (
                    <View style={{ marginTop: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
                      {Object.entries(selectedStats.vibesLastHour as Record<string, number>).map(([v, c]) => (
                        <View key={v} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#eef1f6', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18 }}>
                          <Text style={{ fontSize: 22 }}>{v}</Text>
                          <Text style={{ marginLeft: 8, fontSize: 14, color: '#111', fontWeight: '600' }}>{c}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                  <View style={{ height: 16 }} />
                </>
              ) : (
                <Text style={styles.sheetText}>Loading…</Text>
              )}
              {/* Vibe buttons */}
              {selectedBuilding && (
                <View style={{ flexDirection: 'row', gap: 18, justifyContent: 'center', marginTop: 4 }}>
                  {['👍','🔥','🎉','😴'].map((vb) => {
                    const selected = selectedStats?.myVibe === vb;
                    const allowed = !!selectedStats?.amIPresent;
                    return (
                      <Pressable
                        key={vb}
                        disabled={selected || !allowed}
                        onPress={async () => { try { const { sendVibe } = await import('./src/lib/vibes'); await sendVibe(`b:${selectedBuilding.id}`, vb); const stats = await fetchStats(`b:${selectedBuilding.id}`); setSelectedStats(stats); } catch {} }}
                        style={{ backgroundColor: selected ? '#dbe7ff' : allowed ? '#eef1f6' : '#f1f1f1', width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', opacity: selected || !allowed ? 0.6 : 1 }}>
                        <Text style={{ fontSize: 26 }}>{vb}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
              {!selectedStats?.amIPresent && (
                <Text style={{ textAlign: 'center', color: '#666', marginTop: 6 }}>Move closer and keep Pulse on to react</Text>
              )}
                  {/* swipe down or tap backdrop to close */}
                </View>
              )}
            </ScrollView>
          </Animated.View>
        </View>
      </Modal>
      <StatusBar style="dark" />

    </SafeAreaView>
  );
}

function AboutScreen() {
  const { showStats, setShowStats } = useContext(SettingsContext);
  return (
    <SafeAreaView style={styles.aboutWrap}>
      <Text style={styles.aboutTitle}>About & Privacy</Text>
      <Text style={styles.aboutText}>BuzzPulse aggregates anonymous, coarse building hits to show campus activity. Your device never sends precise GPS or residential locations; only in-zone building IDs are used.</Text>
      <Text style={styles.aboutText}>Heat decays over time so the map reflects recent activity. Cells are served only when there are enough recent hits.</Text>
      <View style={{ height: 16 }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 16 }}>Stats for nerds</Text>
        <Switch
          value={showStats}
          onValueChange={async (v) => { setShowStats(v); try { await AsyncStorage.setItem('showStats', v ? '1' : '0'); } catch {} }}
        />
      </View>
    </SafeAreaView>
  );
}

const Tab = createBottomTabNavigator();

export default function App() {
  const [showStats, setShowStats] = useState(false);
  useEffect(() => {
    (async () => { try { const v = await AsyncStorage.getItem('showStats'); if (v === '1') setShowStats(true); } catch {} })();
  }, []);
  return (
    <SafeAreaProvider>
      <SettingsContext.Provider value={{ showStats, setShowStats }}>
        <NavigationContainer>
          <Tab.Navigator
          screenOptions={({ route }) => ({
            headerShown: false,
            tabBarIcon: ({ color, size, focused }) => {
              if (route.name === 'Map') {
                return <Ionicons name={focused ? 'map' : 'map-outline'} size={size} color={color} />;
              }
              return <Ionicons name={focused ? 'information-circle' : 'information-circle-outline'} size={size} color={color} />;
            },
            tabBarActiveTintColor: '#111',
            tabBarInactiveTintColor: '#666',
          })}
          >
            <Tab.Screen name="Map" component={MapScreen} />
            <Tab.Screen name="About" component={AboutScreen} />
          </Tab.Navigator>
        </NavigationContainer>
      </SettingsContext.Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  topBar: {
    position: 'absolute',
    top: 12,
    left: 16,
    right: 16,
    padding: 8,
    backgroundColor: 'transparent',
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 18, fontWeight: '600' },
  status: {
    position: 'absolute',
    bottom: 100,
    left: 16,
    right: 16,
    backgroundColor: 'transparent',
    padding: 8,
    borderRadius: 14,
  },
  statusText: { fontSize: 12, color: '#333' },
  error: { position: 'absolute', bottom: 20, left: 16, right: 16, color: 'crimson' },
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.25)' },
  sheetContainer: { backgroundColor: '#fff', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 16, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '80%', height: '60%' },
  sheetContent: { paddingBottom: 12 },
  sheetTitle: { fontSize: 16, fontWeight: '600', marginBottom: 6 },
  sheetText: { fontSize: 13, color: '#333' },
  dragBar: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: '#ddd', marginBottom: 10 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  statCard: { width: '47%', backgroundColor: '#f6f7fb', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 10, alignItems: 'center' },
  statValue: { fontSize: 22, fontWeight: '700', color: '#111' },
  statLabel: { fontSize: 11, color: '#666', marginTop: 4 },
  aboutWrap: { flex: 1, padding: 16 },
  aboutTitle: { fontSize: 22, fontWeight: '700', marginBottom: 8 },
  aboutText: { fontSize: 14, color: '#333', marginBottom: 8 },
  pillBtn: { backgroundColor: '#0A84FF', borderRadius: 22, paddingHorizontal: 12, height: 34, flexDirection: 'row', alignItems: 'center', gap: 6 },
  pillBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
});
