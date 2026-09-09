import type * as D3 from "d3";
import { bezierPoint, type LayoutEdge } from "../layout.js";
import type { Generation } from "./flow.js";

/**
 * Animation — UI spec §0 and §7. The graph is drawn once and stays put; this
 * module moves objects along edges that already exist. It never adds, hides
 * or reveals a node or an edge. The plan it runs comes from the pure flow
 * module, so what travels is decided before anything moves; this file only
 * decides when.
 *
 * Runs in the browser as an inline script; `d3` is a global.
 */
declare const d3: typeof D3;

export type PlayerState = "idle" | "playing" | "paused" | "done";

export interface PlayerHooks {
  /** An edge is being travelled: emphasise it (§0, dim inactive edges). */
  readonly onTravel: (edgeId: string) => void;
  /** An object arrived at a node. */
  readonly onArrive: (nodeId: string) => void;
  /** A play is starting from its first generation: previous travel marks are stale. */
  readonly onRestart: () => void;
  /** §7.3: a travelling object was clicked. The player pauses first. */
  readonly onObjectClick: (edgeId: string) => void;
  readonly onState: (state: PlayerState) => void;
}

export interface Player {
  play(plan: readonly Generation[]): void;
  pause(): void;
  resume(): void;
  toggle(): void;
  /** §7.1: advance one hop — one generation — then pause. */
  step(): void;
  replay(): void;
  stop(): void;
  setSpeed(multiplier: number): void;
  setLoop(loop: boolean): void;
  readonly state: PlayerState;
}

/** §7.2: a fixed baseline per hop, in ms at speed 1. Invented, not measured. */
export const BASE_HOP_MS = 1100;

interface Flight {
  readonly edge: LayoutEdge;
  readonly ms: number;
  readonly hasPayload: boolean;
  readonly el: D3.Selection<SVGGElement, unknown, null, undefined>;
  arrived: boolean;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export function createPlayer(
  layer: D3.Selection<SVGGElement, unknown, null, undefined>,
  edgeById: ReadonlyMap<string, LayoutEdge>,
  hooks: PlayerHooks,
): Player {
  let plan: readonly Generation[] = [];
  let generation = 0;
  let flights: Flight[] = [];
  let elapsed = 0;
  let lastFrame: number | null = null;
  let speed = 1;
  let loop = false;
  let stopAfterGeneration = false;
  let state: PlayerState = "idle";
  let frame = 0;

  const setState = (next: PlayerState): void => {
    if (state === next) return;
    state = next;
    hooks.onState(next);
  };

  const clearFlights = (): void => {
    for (const f of flights) f.el.remove();
    flights = [];
  };

  const launch = (): boolean => {
    clearFlights();
    const gen = plan[generation];
    if (gen === undefined) return false;
    elapsed = 0;
    for (const hop of gen) {
      const le = edgeById.get(hop.edge.id);
      if (le === undefined) continue; // Never draw what the layout did not place.
      hooks.onTravel(hop.edge.id);
      const hasPayload = hop.edge.schema_id !== null;
      const el = layer
        .append("g")
        .attr("class", "object")
        .style("cursor", "pointer")
        .on("click", (ev: MouseEvent) => {
          ev.stopPropagation();
          pause();
          hooks.onObjectClick(hop.edge.id);
        });
      // A filled object carries a known payload shape; a hollow one has no
      // schema attached. Shape, not colour, so it reads in greyscale.
      el.append("circle")
        .attr("r", 7)
        .attr("fill", hasPayload ? "#1d1d1f" : "#fff")
        .attr("stroke", hasPayload ? "#fff" : "#1d1d1f")
        .attr("stroke-width", 2);
      el.append("title").text(
        hop.edge.label ?? hop.edge.kind + (hasPayload ? "" : " (no schema)"),
      );
      flights.push({
        edge: le,
        ms: BASE_HOP_MS * hop.duration,
        hasPayload,
        el,
        arrived: false,
      });
      const start = bezierPoint(le, 0);
      el.attr("transform", `translate(${String(start.x)},${String(start.y)})`);
    }
    return flights.length > 0;
  };

  const tick = (now: number): void => {
    frame = 0;
    if (state !== "playing") return;
    if (lastFrame !== null) elapsed += (now - lastFrame) * speed;
    lastFrame = now;
    let allArrived = true;
    for (const f of flights) {
      const t = Math.min(1, elapsed / f.ms);
      const p = bezierPoint(f.edge, smooth(t));
      f.el.attr("transform", `translate(${String(p.x)},${String(p.y)})`);
      if (t >= 1 && !f.arrived) {
        f.arrived = true;
        hooks.onArrive(f.edge.edge.to);
        f.el.attr("opacity", 0);
      }
      if (t < 1) allArrived = false;
    }
    if (allArrived) {
      generation += 1;
      if (generation >= plan.length) {
        if (loop && plan.length > 0) {
          generation = 0;
          hooks.onRestart();
          launch();
        } else {
          clearFlights();
          setState("done");
          return;
        }
      } else {
        launch();
        if (stopAfterGeneration) {
          stopAfterGeneration = false;
          // The next generation is on the map at its start points; pause there.
          lastFrame = null;
          setState("paused");
          return;
        }
      }
    }
    frame = requestAnimationFrame(tick);
  };

  const run = (): void => {
    lastFrame = null;
    setState("playing");
    if (frame === 0) frame = requestAnimationFrame(tick);
  };

  const pause = (): void => {
    if (state !== "playing") return;
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    setState("paused");
  };

  const player: Player = {
    play(next) {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      plan = next;
      generation = 0;
      stopAfterGeneration = false;
      hooks.onRestart();
      if (!launch()) {
        setState("done");
        return;
      }
      run();
    },
    pause,
    resume() {
      if (state === "paused") run();
      else if (state === "done" || state === "idle") player.replay();
    },
    toggle() {
      if (state === "playing") pause();
      else player.resume();
    },
    step() {
      if (state === "playing") {
        stopAfterGeneration = true;
        return;
      }
      if (state === "done" || state === "idle") {
        if (plan.length === 0) return;
        generation = 0;
        hooks.onRestart();
        if (!launch()) return;
      }
      stopAfterGeneration = true;
      run();
    },
    replay() {
      player.play(plan);
    },
    stop() {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      clearFlights();
      plan = [];
      generation = 0;
      setState("idle");
    },
    setSpeed(multiplier) {
      speed = multiplier > 0 ? multiplier : 1;
    },
    setLoop(next) {
      loop = next;
    },
    get state() {
      return state;
    },
  };
  return player;
}
