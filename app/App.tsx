import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, StyleSheet, Text, View, Switch, Modal, Platform, ScrollView, Pressable } from 'react-native';
import MapView, { Circle, Polygon, MapViewProps, PROVIDER_DEFAULT, Region, MapType, MapPressEvent } from 'react-native-maps';
import * as Location from 'expo-location';
import { fetchHeat, HeatPoint } from './src/lib/api';
import { ingestHit } from './src/lib/ingest';
import campusMask from './assets/masks/campus.json';
import { extractPolygons, pointInPolygon } from './src/lib/pip';
import { BUILDINGS, findNearestBuilding } from './src/lib/buildings';
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

export default function App() {
  const mapRef = useRef<MapView>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [heat, setHeat] = useState<HeatPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pulsing, setPulsing] = useState(false);
  const [pulseCount, setPulseCount] = useState(0);
  const [lastUpload, setLastUpload] = useState<string | null>(null);
  const pulseTimer = useRef<NodeJS.Timer | null>(null);
  const [droppedCount, setDroppedCount] = useState(0);
  const [showMasks, setShowMasks] = useState(true);
  // Include-only filter: only send hits inside campus polygons
  const [filterEnabled, setFilterEnabled] = useState(true);
  const [mapType, setMapType] = useState<MapType>('standard');
  const [selectedBuilding, setSelectedBuilding] = useState<{ id: string; name: string } | null>(null);
  const [selectedStats, setSelectedStats] = useState<any>(null);
  const SELECT_DISTANCE_M = 80;

  const campusPolys = useMemo(() => extractPolygons(campusMask), []);
  const campusPolysLatLng = useMemo(() =>
    campusPolys.map((poly) => poly.map(([lng, lat]) => ({ latitude: lat, longitude: lng }))),
    [campusPolys]
  );

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

  const sampleAndSend = async () => {
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = loc.coords;
      const pt: [number, number] = [longitude, latitude];

      // Include-only: if filter is enabled and we have campus polygons, drop points outside them
      if (filterEnabled && campusPolys.length > 0) {
        const inCampus = campusPolys.some((poly) => pointInPolygon(pt, poly));
        if (!inCampus) {
          setDroppedCount((c) => c + 1);
          return; // do not send
        }
      }

      // Pick nearest building center; send building-based cellId
      const b = findNearestBuilding(latitude, longitude);
      if (!b) {
        setDroppedCount((c) => c + 1);
        return;
      }
      const cellId = `b:${b.id}`;
      const ts = Math.floor(Date.now() / 1000);
      await ingestHit(cellId, ts);
      setPulseCount((c) => c + 1);
      setLastUpload(new Date().toLocaleTimeString());
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

  return (
    <View style={styles.container}>
      {region && (
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          provider={PROVIDER_DEFAULT}
          initialRegion={region}
          mapType={mapType}
          onRegionChangeComplete={onRegionChangeComplete}
          onPress={(e: MapPressEvent) => {
            const { latitude, longitude } = e.nativeEvent.coordinate;
            const b = findNearestBuilding(latitude, longitude);
            if (!b) return;
            const d = haversineMeters({ latitude, longitude }, b.center);
            if (d <= SELECT_DISTANCE_M) handleSelectBuilding(b.id, b.name);
          }}
        >
          {showMasks && (
            <>
              {campusPolysLatLng.map((coords, idx) => (
                <Polygon key={`campus-${idx}`} coordinates={coords} strokeColor="#0066cc" strokeWidth={2} fillColor="rgba(0,102,204,0.07)" />
              ))}
            </>
          )}

          {BUILDINGS.map((b) => (
            <Polygon
              key={`b-${b.id}`}
              coordinates={b.polygon}
              strokeColor={showMasks ? '#333333' : 'transparent'}
              strokeWidth={showMasks ? 1 : 0}
              fillColor={showMasks ? 'rgba(50,50,50,0.15)' : 'transparent'}
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
      <View style={styles.topBar}>
        <Text style={styles.title}>BuzzPulse</Text>
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Button title={loading ? 'Refreshing…' : 'Refresh'} onPress={refreshHeat} disabled={loading} />
          {pulsing ? (
            <Button title="Stop Pulse" onPress={stopPulse} />
          ) : (
            <Button title="Start Pulse" onPress={startPulse} />
          )}
          <Button title={mapType === 'standard' ? 'Map: Std' : 'Map: Sat'} onPress={() => setMapType(mapType === 'standard' ? 'satellite' : 'standard')} />
        </View>
      </View>
      <View style={styles.status}>
        <Text style={styles.statusText}>Pulses sent (in zones): {pulseCount}</Text>
        <Text style={styles.statusText}>Dropped (outside zones): {droppedCount}</Text>
        <Text style={styles.statusText}>Last upload: {lastUpload ?? '—'}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={styles.statusText}>Show zones</Text>
            <Switch value={showMasks} onValueChange={setShowMasks} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={styles.statusText}>Limit to zones</Text>
            <Switch value={filterEnabled} onValueChange={setFilterEnabled} />
          </View>
        </View>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Modal
        visible={!!selectedBuilding}
        animationType="slide"
        transparent
        onRequestClose={() => { setSelectedBuilding(null); setSelectedStats(null); }}
      >
        <View style={styles.modalRoot}>
          <Pressable style={styles.overlay} onPress={() => { setSelectedBuilding(null); setSelectedStats(null); }} />
          <View style={styles.sheetContainer}>
            <View style={styles.dragBar} />
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
                      <View style={{ height: 16 }} />
                    </>
                  ) : (
                    <Text style={styles.sheetText}>Loading…</Text>
                  )}
                  <Button title="Close" onPress={() => { setSelectedBuilding(null); setSelectedStats(null); }} />
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
      <StatusBar style="dark" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  topBar: {
    position: 'absolute',
    top: 50,
    left: 16,
    right: 16,
    padding: 8,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { fontSize: 18, fontWeight: '600' },
  status: {
    position: 'absolute',
    bottom: 80,
    left: 16,
    right: 16,
    backgroundColor: 'rgba(255,255,255,0.9)',
    padding: 8,
    borderRadius: 8,
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
});
