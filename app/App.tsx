import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, StyleSheet, Text, View, Switch } from 'react-native';
import MapView, { Circle, Polygon, MapViewProps, PROVIDER_DEFAULT, Region, MapType } from 'react-native-maps';
import * as Location from 'expo-location';
import { fetchHeat, HeatPoint } from './src/lib/api';
import { encode as encodeGeohash } from './src/lib/geohash';
import { ingestHit } from './src/lib/ingest';
import campusMask from './assets/masks/campus.json';
import { extractPolygons, pointInPolygon } from './src/lib/pip';

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

      const cellId = encodeGeohash(latitude, longitude, 7);
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
        >
          {/* Inclusion zone overlays (toggled) */}
          {showMasks && (
            <>
              {campusPolysLatLng.map((coords, idx) => (
                <Polygon key={`campus-${idx}`} coordinates={coords} strokeColor="#0066cc" strokeWidth={2} fillColor="rgba(0,102,204,0.07)" />
              ))}
            </>
          )}
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
});
