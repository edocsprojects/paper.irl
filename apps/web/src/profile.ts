/** Local profile + lifetime stats. Identity for the live event is guestId or the Google account. */
export interface Profile {
  name: string;
  photo: string | null;
  signIn: "google" | "guest" | null;
  /** Share GPS during play. Off = spectator only (not part of the game). */
  useLocation: boolean;
  theme: "light" | "dark";
  /** "gps" = real live event; "demo" = local bot simulation. */
  mode: "gps" | "demo";
  demoSpeed: number;
  guestId: string;
  gamesPlayed: number;
  allTimeScoreM2: number;
  bestRank: number | null;
  bestGameM2: number;
  wins: number;
  totalPlayMs: number;
}

const KEY = "paper-irl.profile.v1";

function newGuestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

function defaults(): Profile {
  return {
    name: "You",
    photo: null,
    signIn: null,
    useLocation: true,
    theme: "light",
    mode: "gps",
    demoSpeed: 1,
    guestId: newGuestId(),
    gamesPlayed: 0,
    allTimeScoreM2: 0,
    bestRank: null,
    bestGameM2: 0,
    wins: 0,
    totalPlayMs: 0,
  };
}

export function loadProfile(): Profile {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = { ...base, ...(JSON.parse(raw) as Partial<Profile>) };
      if ((p.signIn as string) === "apple") p.signIn = "guest";
      p.demoSpeed = Math.min(20, Math.max(1, Math.round(p.demoSpeed)));
      return p;
    }
  } catch {
    // Storage blocked or corrupt — fall back to defaults.
  }
  return base;
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Quota (large photo) or blocked storage — keep in memory only.
  }
}
