import { useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { buildMapHtml } from "./mapHtml";
import type { LobbyPayload, SeatView } from "../lib/api";

type Props = {
  lobby: LobbyPayload;
  youId: number;
  remainingMs: number;
};

export function GameMap({ lobby, youId, remainingMs }: Props) {
  const ref = useRef<WebView>(null);

  useEffect(() => {
    const seats = lobby.seats.map((s: SeatView) => ({
      ...s,
      you: s.id === youId,
    }));
    const msg = JSON.stringify({
      type: "state",
      state: {
        graph: lobby.graph,
        seats,
        top3: lobby.top3,
        remainingMs,
      },
    });
    ref.current?.postMessage(msg);
  }, [lobby, youId, remainingMs]);

  return (
    <WebView
      ref={ref}
      originWhitelist={["*"]}
      source={{ html: buildMapHtml() }}
      style={styles.map}
      javaScriptEnabled
      domStorageEnabled
      allowFileAccess
      mixedContentMode="always"
      onMessage={() => {}}
    />
  );
}

const styles = StyleSheet.create({
  map: { flex: 1, backgroundColor: "#e8ecef" },
});
