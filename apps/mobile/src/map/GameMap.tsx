import { useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { buildMapHtml, MAP_HTML_REVISION } from "./mapHtml";
import type { LobbyPayload, SeatView } from "../lib/api";

type Props = {
  lobby: LobbyPayload;
  youId: number;
  /** Manual mode: drag on map moves the local player (Simulator). */
  dragEnabled?: boolean;
  onDragMove?: (lat: number, lon: number) => void;
};

export function mapFingerprint(lobby: LobbyPayload, youId: number): string {
  const seats = lobby.seats
    .map((s) => {
      const tip = s.trail.length ? s.trail[s.trail.length - 1] : null;
      const p = s.position ?? s.respawnAt;
      return [
        s.id,
        s.mode,
        Math.round(s.areaM2),
        s.trail.length,
        s.owned.length,
        p ? `${p.lat.toFixed(6)},${p.lon.toFixed(6)}` : "",
        tip ? `${tip.lat.toFixed(6)},${tip.lon.toFixed(6)}` : "",
        s.respawnAt ? s.respawnAt.lat.toFixed(6) : "",
        s.id === youId ? "1" : "0",
      ].join(":");
    })
    .join("|");
  return `${lobby.arena.id}#${lobby.phase}#${seats}`;
}

function buildStateMessage(
  lobby: LobbyPayload,
  youId: number,
  dragEnabled: boolean,
): string {
  const seats = lobby.seats.map((s: SeatView) => ({
    ...s,
    you: s.id === youId,
  }));
  return JSON.stringify({
    type: "state",
    state: {
      arena: lobby.arena,
      mode: lobby.mode,
      seats,
      top3: lobby.top3,
      dragEnabled,
    },
  });
}

/** Street-map WebView — labels stripped; HUD is RN. */
export function GameMap({
  lobby,
  youId,
  dragEnabled = false,
  onDragMove,
}: Props) {
  const ref = useRef<WebView>(null);
  const lastFp = useRef("");
  const ready = useRef(false);
  const lobbyRef = useRef(lobby);
  const youRef = useRef(youId);
  const dragRef = useRef(dragEnabled);
  const onDragRef = useRef(onDragMove);
  lobbyRef.current = lobby;
  youRef.current = youId;
  dragRef.current = dragEnabled;
  onDragRef.current = onDragMove;

  useEffect(() => {
    const fp = `${mapFingerprint(lobby, youId)}#drag:${dragEnabled ? 1 : 0}`;
    if (fp === lastFp.current) return;
    lastFp.current = fp;
    if (!ready.current) return;
    ref.current?.postMessage(buildStateMessage(lobby, youId, dragEnabled));
  }, [lobby, youId, dragEnabled]);

  return (
    <WebView
      key={`map-${MAP_HTML_REVISION}`}
      ref={ref}
      originWhitelist={["*"]}
      source={{ html: buildMapHtml() }}
      style={styles.map}
      javaScriptEnabled
      domStorageEnabled
      allowFileAccess
      mixedContentMode="always"
      onMessage={(ev) => {
        try {
          const msg = JSON.parse(ev.nativeEvent.data);
          if (msg.type === "ready") {
            ready.current = true;
            lastFp.current = `${mapFingerprint(lobbyRef.current, youRef.current)}#drag:${dragRef.current ? 1 : 0}`;
            ref.current?.postMessage(
              buildStateMessage(
                lobbyRef.current,
                youRef.current,
                dragRef.current,
              ),
            );
          } else if (msg.type === "move" && typeof msg.lat === "number") {
            onDragRef.current?.(msg.lat, msg.lon);
          }
        } catch {
          /* ignore */
        }
      }}
    />
  );
}

const styles = StyleSheet.create({
  map: { flex: 1, backgroundColor: "#dfe5ea" },
});
