import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Location from "expo-location";
import { api, type LobbyPayload } from "../lib/api";
import type { Session } from "./LobbyScreen";
import { GameMap } from "../map/GameMap";

type Props = { session: Session; onExit: () => void };

export function GameScreen({ session, onExit }: Props) {
  const [lobby, setLobby] = useState<LobbyPayload | null>(null);
  const [snack, setSnack] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const auto = session.mode === "join-bots" || session.mode === "host-bots";
  const plantedOnce = useRef(false);

  const you = useMemo(
    () => lobby?.seats.find((s) => s.id === session.seatId) ?? null,
    [lobby, session.seatId],
  );

  const needSpawn =
    lobby?.phase === "live" &&
    !!you &&
    (you.mode === "toPlant" || you.mode === "joining" || you.mode === "ghost");

  const remainingMs = Math.max(
    0,
    (lobby?.endsAtMs ?? Date.now()) - Date.now(),
  );

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const next = await api.get(session.code);
        if (!cancelled) setLobby(next);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    refresh();
    const id = setInterval(refresh, auto ? 1500 : 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session.code, auto]);

  // Human GPS (or mock when denied / emulator)
  useEffect(() => {
    if (auto || !lobby || lobby.phase !== "live" || needSpawn) return;
    let sub: Location.LocationSubscription | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    (async () => {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status === "granted") {
        sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: 1000,
            distanceInterval: 2,
          },
          async (pos) => {
            try {
              await api.fix(session.code, session.seatId, {
                lat: pos.coords.latitude,
                lon: pos.coords.longitude,
                accuracyM: pos.coords.accuracy ?? 10,
                speedMps: pos.coords.speed && pos.coords.speed > 0 ? pos.coords.speed : 1.5,
                clientTsMs: Date.now(),
                mock: false,
              });
            } catch {
              /* ignore transient */
            }
          },
        );
      } else {
        // Emulator fallback: autopilot when no GPS
        timer = setInterval(() => {
          api.autopilot(session.code, session.seatId).then(setLobby).catch(() => undefined);
        }, 1000);
      }
    })();

    return () => {
      sub?.remove();
      if (timer) clearInterval(timer);
    };
  }, [auto, lobby?.phase, needSpawn, session.code, session.seatId]);

  // Auto-pilot human seat for bot modes
  useEffect(() => {
    if (!auto || !lobby || lobby.phase !== "live") return;
    const id = setInterval(() => {
      api.autopilot(session.code, session.seatId).then((next) => {
        setLobby(next);
        const me = next.seats.find((s) => s.id === session.seatId);
        if (me && me.mode === "safe") plantedOnce.current = true;
      }).catch(() => undefined);
    }, 1000);
    return () => clearInterval(id);
  }, [auto, lobby?.phase, session.code, session.seatId]);

  async function spawn() {
    if (!you) return;
    try {
      // Autopilot plants at marker; for human, send fix at respawn node via autopilot plant path
      const next = await api.autopilot(session.code, session.seatId);
      setLobby(next);
      plantedOnce.current = true;
      setSnack("You're planted — go claim paths");
      setTimeout(() => setSnack(null), 3500);
    } catch (e) {
      setError(String(e));
    }
  }

  if (!lobby) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>{error ?? "Loading lobby…"}</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <GameMap lobby={lobby} youId={session.seatId} remainingMs={remainingMs} />

      <View style={styles.topBar} pointerEvents="box-none">
        <View style={styles.pill}>
          <Text style={styles.pillText}>{lobby.code}</Text>
        </View>
        <Pressable style={styles.pill} onPress={onExit}>
          <Text style={styles.pillText}>Exit</Text>
        </Pressable>
      </View>

      {snack && (
        <View style={styles.snack}>
          <Text style={styles.snackText}>{snack}</Text>
        </View>
      )}

      {needSpawn && !auto && (
        <Pressable style={styles.spawn} onPress={spawn}>
          <View style={styles.spawnCard}>
            <Text style={styles.spawnKicker}>
              {plantedOnce.current ? "Wiped" : "Match start"}
            </Text>
            <Text style={styles.spawnTitle}>
              {plantedOnce.current ? "Respawn" : "Ready to plant"}
            </Text>
            <Text style={styles.spawnCopy}>
              Tap anywhere to plant at your marker. Other players keep moving.
            </Text>
            <View style={styles.spawnBtn}>
              <Text style={styles.spawnBtnText}>Spawn</Text>
            </View>
          </View>
        </Pressable>
      )}

      {lobby.phase === "ended" && (
        <View style={styles.spawn}>
          <View style={styles.spawnCard}>
            <Text style={styles.spawnKicker}>Time’s up</Text>
            <Text style={styles.spawnTitle}>Final top 3</Text>
            {lobby.top3.map((s, i) => (
              <Text key={s.id} style={styles.finalRow}>
                {i + 1}. {s.nickname} — {Math.round(s.areaM2)} m²
              </Text>
            ))}
            <Pressable style={styles.spawnBtn} onPress={onExit}>
              <Text style={styles.spawnBtnText}>Back</Text>
            </Pressable>
          </View>
        </View>
      )}

      {lobby.phase === "open" && session.mode === "human" && (
        <Pressable
          style={styles.startFab}
          onPress={async () => {
            try {
              await api.start(session.code);
              setLobby(await api.get(session.code));
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          <Text style={styles.spawnBtnText}>Start match</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#e8ecef" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  muted: { color: "#6b7280", fontWeight: "600" },
  topBar: {
    position: "absolute",
    top: 48,
    left: 12,
    right: 12,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  pill: {
    backgroundColor: "rgba(255,255,255,0.94)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  pillText: { fontWeight: "800", color: "#1b1b1b" },
  snack: {
    position: "absolute",
    bottom: 36,
    alignSelf: "center",
    backgroundColor: "rgba(22,101,52,0.95)",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    maxWidth: "90%",
  },
  snackText: { color: "#fff", fontWeight: "700" },
  spawn: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(232,236,239,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  spawnCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: 20,
    alignItems: "center",
  },
  spawnKicker: {
    color: "#e85d04",
    fontWeight: "800",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontSize: 11,
  },
  spawnTitle: {
    marginTop: 6,
    fontSize: 26,
    fontWeight: "800",
    color: "#1b1b1b",
  },
  spawnCopy: {
    marginTop: 8,
    textAlign: "center",
    color: "#6b7280",
    fontWeight: "600",
    lineHeight: 20,
  },
  spawnBtn: {
    marginTop: 16,
    backgroundColor: "#e85d04",
    borderRadius: 999,
    paddingHorizontal: 28,
    paddingVertical: 12,
  },
  spawnBtnText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  finalRow: { marginTop: 8, fontWeight: "700", color: "#1b1b1b" },
  startFab: {
    position: "absolute",
    bottom: 40,
    alignSelf: "center",
    backgroundColor: "#e85d04",
    borderRadius: 999,
    paddingHorizontal: 28,
    paddingVertical: 14,
  },
});
