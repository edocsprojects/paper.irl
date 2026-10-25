import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState as RNAppState, StyleSheet, Text, View } from "react-native";
import {
  api,
  type LobbyPayload,
  type LobbyWithEffects,
} from "../lib/api";
import { defaultMoveMode, type MoveMode } from "../lib/config";
import { useGps, type GpsFix } from "../lib/location";
import { snacksFromEffects } from "../lib/effectSnacks";
import { GameMap, mapFingerprint } from "../map/GameMap";
import { SnackbarHost } from "../components/SnackbarHost";
import { PlayHud } from "../components/PlayHud";
import { KillFeed } from "../components/KillFeed";
import { useGameNotices } from "../lib/useGameNotices";
import type { ZoomMode } from "../map/paintPayload";
import { colors, fonts } from "../theme/tokens";
import {
  spawnOverlayVisible,
  type AppState,
  type AppEvent,
  type Session,
} from "../state/appMachine";
import { SpawnHint, SpawnOverlay } from "./SpawnOverlay";
import { ResultsOverlay } from "./ResultsOverlay";
import { RematchWaiting } from "./RematchWaiting";
import { LobbyCardScreen } from "./LobbyCardScreen";
import { CountdownOverlay } from "./CountdownOverlay";

type Props = {
  state: AppState;
  session: Session;
  dispatch: (e: AppEvent) => void;
  onHostStarted: (lobby: LobbyPayload) => void;
};

/**
 * Live play. The local seat moves with the phone's real GPS (default) or,
 * for Simulator/dev, the server autopilot. Spawning: the player taps once to
 * arm; their starter is planted where they stand (or at the nearest clear
 * marker, planted on arrival). Bots auto-move + auto-respawn on the server.
 */
export function GameScreen({
  state,
  session,
  dispatch,
  onHostStarted,
}: Props) {
  const lobby = state.lobby;
  const failCount = useRef(0);
  const lastFp = useRef("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [startBusy, setStartBusy] = useState(false);
  // Fixed per build: phones use GPS; the bot demo walks you automatically.
  const [moveMode] = useState<MoveMode>(defaultMoveMode);
  const [zoomMode, setZoomMode] = useState<ZoomMode>("arena");
  // Respawns are automatic (walk into the ring); only the first spawn is a tap.
  const armedRef = useRef(state.spawnArmed || state.plantedOnce);
  armedRef.current = state.spawnArmed || state.plantedOnce;

  const you = useMemo(
    () => lobby?.seats.find((s) => s.id === session.seatId) ?? null,
    [lobby, session.seatId],
  );

  const remainingMs = Math.max(0, (lobby?.endsAtMs ?? nowMs) - nowMs);
  useGameNotices(lobby, session.seatId, remainingMs, (text, tone) =>
    dispatch({ type: "SNACK", text, tone }),
  );
  // Server-clock offset so the kill feed fades on the server's timeline.
  const skewMs = useMemo(
    () => (lobby?.serverNowMs ? lobby.serverNowMs - Date.now() : 0),
    [lobby],
  );

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const pushLobby = useCallback(
    (next: LobbyPayload) => {
      failCount.current = 0;
      const fp = `${next.phase}#${mapFingerprint(next, session.seatId)}`;
      if (fp === lastFp.current) return;
      lastFp.current = fp;
      dispatch({ type: "LOBBY", lobby: next });
    },
    [dispatch, session.seatId],
  );

  const applyEffects = useCallback(
    (next: LobbyWithEffects) => {
      pushLobby(next);
      for (const snack of snacksFromEffects(
        next.effects,
        session.seatId,
        next,
      )) {
        dispatch({ type: "SNACK", text: snack.text, tone: snack.tone });
      }
    },
    [pushLobby, dispatch, session.seatId],
  );

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const next = await api.get(session.code);
        if (!cancelled) pushLobby(next);
      } catch (e) {
        failCount.current += 1;
        if (!cancelled && failCount.current >= 3) {
          dispatch({ type: "FAIL", error: String(e) });
        }
      }
    }
    refresh();
    // ~4 Hz: the map glides between updates, so this reads as smooth motion.
    const id = setInterval(refresh, 250);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session.code, pushLobby, dispatch]);

  useEffect(() => {
    const sub = RNAppState.addEventListener("change", (next) => {
      if (next === "active") {
        dispatch({ type: "APP_FG" });
        api
          .get(session.code)
          .then(pushLobby)
          .catch((e) => dispatch({ type: "FAIL", error: String(e) }));
      } else if (next === "background" || next === "inactive") {
        dispatch({ type: "APP_BG" });
      }
    });
    return () => sub.remove();
  }, [dispatch, pushLobby, session.code]);

  useEffect(() => {
    if (state.screen !== "countdown" || state.countdown == null) return;
    if (state.countdown <= 0) {
      dispatch({ type: "COUNTDOWN", n: null });
      return;
    }
    const t = setTimeout(() => {
      const next = state.countdown! - 1;
      dispatch({ type: "COUNTDOWN", n: next > 0 ? next : null });
    }, 700);
    return () => clearTimeout(t);
  }, [state.screen, state.countdown, dispatch]);

  // ── Real GPS → server (one request in flight; newest fix wins) ──
  const inflight = useRef(false);
  const queued = useRef<GpsFix | null>(null);
  const sendFix = useCallback(
    async (fix: GpsFix) => {
      if (inflight.current) {
        queued.current = fix;
        return;
      }
      inflight.current = true;
      try {
        let next: GpsFix | null = fix;
        while (next) {
          queued.current = null;
          const res = await api.fix(session.code, session.seatId, {
            lat: next.lat,
            lon: next.lon,
            accuracyM: next.accuracyM,
            speedMps: next.speedMps,
            clientTsMs: next.tsMs,
            plant: armedRef.current,
          });
          applyEffects(res);
          next = queued.current;
        }
      } catch {
        /* next fix retries */
      } finally {
        inflight.current = false;
      }
    },
    [session.code, session.seatId, applyEffects],
  );
  const gpsOn = moveMode === "gps" && !!lobby && lobby.phase !== "ended";
  const gps = useGps(gpsOn, sendFix);

  // ── Dev autopilot (no GPS): server walks the seat; plants only once armed ──
  useEffect(() => {
    if (moveMode !== "auto") return;
    if (!lobby || lobby.phase !== "live") return;
    if (state.countdown != null) return;
    const id = setInterval(() => {
      api
        .autopilot(session.code, session.seatId, { autoPlant: armedRef.current })
        .then(applyEffects)
        .catch(() => undefined);
    }, 200);
    return () => clearInterval(id);
  }, [
    moveMode,
    lobby?.phase,
    session.code,
    session.seatId,
    applyEffects,
    state.countdown,
  ]);

  function spawn() {
    armedRef.current = true;
    dispatch({ type: "SPAWN_ARMED" });
    // Plant right away from the latest real fix instead of waiting ~1 s.
    if (moveMode === "gps" && gps.fix) sendFix({ ...gps.fix, tsMs: Date.now() });
  }

  // host-bots demo: tap Spawn automatically.
  const showSpawnNow = spawnOverlayVisible(state.screen, state.spawnArmed);
  useEffect(() => {
    if (session.mode !== "host-bots" || !showSpawnNow) return;
    const id = setTimeout(spawn, 1200);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.mode, showSpawnNow]);

  async function playAgain() {
    try {
      const next = await api.rematchReady(session.code, session.seatId);
      pushLobby(next);
      dispatch({ type: "PLAY_AGAIN_READY" });
    } catch (e) {
      dispatch({ type: "FAIL", error: String(e) });
    }
  }

  async function startRematch() {
    try {
      const next = await api.rematchStart(session.code, session.seatId);
      pushLobby(next);
      dispatch({ type: "COUNTDOWN", n: 3 });
    } catch (e) {
      dispatch({ type: "FAIL", error: String(e) });
    }
  }

  if (!lobby) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Loading lobby…</Text>
      </View>
    );
  }

  if (state.screen === "lobby_card" || lobby.phase === "open") {
    return (
      <LobbyCardScreen
        session={session}
        lobby={lobby}
        busy={startBusy}
        setBusy={setStartBusy}
        onLobby={pushLobby}
        onStarted={onHostStarted}
        onFail={(error) => dispatch({ type: "FAIL", error })}
        onLeave={() => dispatch({ type: "EXIT_HOME" })}
      />
    );
  }

  const showSpawn = spawnOverlayVisible(state.screen, state.spawnArmed);
  const awaitingSpawn =
    (state.spawnArmed && state.screen === "match_starting") ||
    state.screen === "death_respawn";
  const showResults = state.screen === "results";
  const showRematch = state.screen === "rematch_waiting";

  return (
    <View style={styles.root}>
      <GameMap lobby={lobby} youId={session.seatId} zoomMode={zoomMode} />

      <PlayHud
        remainingMs={remainingMs}
        top3={lobby.top3}
        youId={session.seatId}
        paused={!state.appActive}
        arenaAreaM2={Math.PI * lobby.arena.radiusM ** 2}
        zoomMode={zoomMode}
        onToggleZoom={() => setZoomMode((z) => (z === "arena" ? "close" : "arena"))}
        onExit={() => dispatch({ type: "EXIT_HOME" })}
      />

      <KillFeed
        feed={lobby.feed ?? []}
        seats={lobby.seats}
        youId={session.seatId}
        nowMs={nowMs + skewMs}
      />

      {awaitingSpawn ? (
        <SpawnHint
          text={state.screen === "death_respawn" ? "Respawn — head to your ring" : "Spawning…"}
        />
      ) : null}

      <SnackbarHost
        snack={state.snack}
        onClear={() => dispatch({ type: "CLEAR_SNACK" })}
      />

      <CountdownOverlay
        active={state.screen === "countdown"}
        mountKey={state.mountKey}
        n={state.countdown}
      />

      <SpawnOverlay
        active={showSpawn && state.screen !== "countdown"}
        mountKey={state.mountKey}
        wiped={state.screen === "death_respawn"}
        onSpawn={spawn}
      />

      <ResultsOverlay
        active={showResults}
        mountKey={state.mountKey}
        top3={lobby.top3}
        rematchReadyCount={(lobby.rematchReady ?? []).length}
        rosterSize={lobby.seats.length}
        onPlayAgain={playAgain}
        onLeave={() => dispatch({ type: "EXIT_HOME" })}
      />

      <RematchWaiting
        active={showRematch}
        mountKey={state.mountKey}
        seats={lobby.seats}
        readyIds={lobby.rematchReady ?? []}
        isHost={session.isHost}
        onStartRematch={startRematch}
        onLeave={() => dispatch({ type: "EXIT_HOME" })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.mapWash },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  muted: { color: colors.muted, fontFamily: fonts.body },
});
