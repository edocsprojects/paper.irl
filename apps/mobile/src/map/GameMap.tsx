import { useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { buildMapHtml, MAP_HTML_REVISION } from "./mapHtml";
import { buildPaperPaintMessage } from "./paintPayload";
import type { LobbyPayload } from "../lib/api";

type Props = {
  lobby: LobbyPayload;
  youId: number;
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

/** Push lobby state into the WebView (injectJavaScript — reliable on iOS HTML). */
function pushState(webRef: WebView | null, json: string) {
  if (!webRef) return;
  const payload = JSON.stringify(json);
  webRef.injectJavaScript(
    `(function(){try{if(window.__paperPaint)window.__paperPaint(${payload});}catch(e){}true;})();`,
  );
}

/** Street-map WebView — labels stripped; HUD is RN. */
export function GameMap({ lobby, youId }: Props) {
  const ref = useRef<WebView>(null);
  const lastFp = useRef("");
  const ready = useRef(false);
  const lobbyRef = useRef(lobby);
  const youRef = useRef(youId);
  lobbyRef.current = lobby;
  youRef.current = youId;

  useEffect(() => {
    const fp = mapFingerprint(lobby, youId);
    if (fp === lastFp.current) return;
    lastFp.current = fp;
    if (!ready.current) return;
    pushState(
      ref.current,
      JSON.stringify(buildPaperPaintMessage(lobby, youId)),
    );
  }, [lobby, youId]);

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
            lastFp.current = mapFingerprint(lobbyRef.current, youRef.current);
            pushState(
              ref.current,
              JSON.stringify(
                buildPaperPaintMessage(lobbyRef.current, youRef.current),
              ),
            );
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
