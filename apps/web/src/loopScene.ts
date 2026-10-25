/**
 * Sign-in illustration: your runner leaves its land, draws a dashed loop,
 * comes home and the land grows into ONE merged territory. Trail tip and
 * runner are computed from the same path length each frame, so they never
 * drift apart (the old CSS mask guessed the length and ran on its own clock).
 */
const CYCLE_MS = 7000;
const DRAW_END = 0.7; // loop finished at 70% of the cycle
const CLAIM_IN = 0.76;
const CLAIM_OUT = 0.92;
const SAMPLE_PX = 3;

export function startLoopScene(root: SVGSVGElement, isVisible: () => boolean): void {
  const loop = root.querySelector<SVGPathElement>("#h-loop");
  const trail = root.querySelector<SVGPathElement>(".h-trail");
  const runner = root.querySelector<SVGCircleElement>(".h-runner");
  const land = root.querySelector<SVGPathElement>(".h-land");
  const merged = root.querySelector<SVGPathElement>(".h-merged");
  if (!loop || !trail || !runner || !land || !merged) return;

  const total = loop.getTotalLength();
  // Pre-sample the loop once; each frame just slices this list.
  const pts: string[] = [];
  for (let d = 0; d <= total; d += SAMPLE_PX) {
    const p = loop.getPointAtLength(d);
    pts.push(`${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  }
  const end = loop.getPointAtLength(total);
  pts.push(`${end.x.toFixed(1)} ${end.y.toFixed(1)}`);

  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    land.style.opacity = "0";
    merged.style.opacity = "1";
    trail.setAttribute("d", "");
    runner.setAttribute("cx", end.x.toFixed(1));
    runner.setAttribute("cy", end.y.toFixed(1));
    return;
  }

  const start = performance.now();
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    if (!isVisible()) return;
    const t = ((now - start) % CYCLE_MS) / CYCLE_MS;
    const k = Math.min(1, t / DRAW_END);
    const n = Math.max(1, Math.round(k * (pts.length - 1)));
    const tip = loop.getPointAtLength(total * k);
    // Trail exactly to the runner.
    trail.setAttribute("d", t < CLAIM_IN ? `M${pts.slice(0, n).join(" L")} L${tip.x.toFixed(1)} ${tip.y.toFixed(1)}` : "");
    runner.setAttribute("cx", tip.x.toFixed(1));
    runner.setAttribute("cy", tip.y.toFixed(1));
    // Claim: old land and the loop become one territory, then reset.
    let m = 0;
    if (t >= DRAW_END && t < CLAIM_IN) m = (t - DRAW_END) / (CLAIM_IN - DRAW_END);
    else if (t >= CLAIM_IN && t < CLAIM_OUT) m = 1;
    else if (t >= CLAIM_OUT) m = 1 - (t - CLAIM_OUT) / (1 - CLAIM_OUT);
    merged.style.opacity = m.toFixed(3);
    land.style.opacity = (1 - m).toFixed(3);
  };
  requestAnimationFrame(frame);
}
