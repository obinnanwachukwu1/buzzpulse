import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import MapView, { Circle, MapViewProps, PROVIDER_DEFAULT, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { fetchHeat, HeatPoint } from './src/lib/api';

export default function App() {
  const mapRef = useRef<MapView>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [heat, setHeat] = useState<HeatPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          onRegionChangeComplete={onRegionChangeComplete}
        >
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
        <Button title={loading ? 'Refreshing…' : 'Refresh'} onPress={refreshHeat} disabled={loading} />
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
  error: { position: 'absolute', bottom: 20, left: 16, right: 16, color: 'crimson' },
});
