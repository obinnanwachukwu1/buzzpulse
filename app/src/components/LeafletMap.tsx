import React, { useMemo } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';

export type HeatPoint = { lat: number; lng: number; score: number; radius: number };
export type Region = { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };

export default function LeafletMap({ region, heat, onTap }: { region: Region; heat: HeatPoint[]; onTap: (lat: number, lng: number) => void }) {
  const html = useMemo(() => buildHtml(region, heat), [region?.latitude, region?.longitude, region?.latitudeDelta, region?.longitudeDelta, heat]);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg?.type === 'tap' && typeof msg.lat === 'number' && typeof msg.lng === 'number') {
        onTap(msg.lat, msg.lng);
      }
    } catch {}
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      <WebView
        originWhitelist={["*"]}
        onMessage={onMessage}
        source={{ html }}
        style={StyleSheet.absoluteFill}
        javaScriptEnabled
        domStorageEnabled
        allowFileAccess
        allowingReadAccessToURL="*"
        mixedContentMode="always"
      />
    </View>
  );
}

function buildHtml(region: Region, heat: HeatPoint[]) {
  const center = [region.latitude, region.longitude];
  const circles = JSON.stringify(heat || []);
  return `<!DOCTYPE html>
  <html>
    <head>
      <meta name="viewport" content="initial-scale=1, maximum-scale=1" />
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <style>
        html, body, #map { height: 100%; margin: 0; padding: 0; }
      </style>
    </head>
    <body>
      <div id="map"></div>
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <script>
        const map = L.map('map', { center: [${center[0]}, ${center[1]}], zoom: 16 });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap'
        }).addTo(map);
        const data = ${circles};
        data.forEach(d => {
          L.circle([d.lat, d.lng], { radius: d.radius, color: 'rgba(255,0,0,0.35)', fillColor: 'rgba(255,0,0,0.2)', fillOpacity: 0.6, weight: 1 }).addTo(map);
        });
        map.on('click', (e) => {
          const msg = JSON.stringify({ type: 'tap', lat: e.latlng.lat, lng: e.latlng.lng });
          if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
            window.ReactNativeWebView.postMessage(msg);
          }
        });
      </script>
    </body>
  </html>`;
}

