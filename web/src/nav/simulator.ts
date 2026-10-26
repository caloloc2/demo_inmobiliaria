import type { Fix } from '../app/gps';
import { pointAt } from './geom';
import type { Route } from './route';

const TICK_MS = 250;

/** Recorre la ruta emitiendo posiciones como si fuera el GPS (para demos sin salir a la calle). */
export class Simulator {
  private timer: number | null = null;
  private traveled = 0;
  /** Velocidad simulada en m/s. */
  speed: number;

  constructor(
    private route: Route,
    private onFix: (f: Fix) => void,
    private onDone: () => void,
    speed: number,
  ) {
    this.speed = speed;
  }

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private tick() {
    const total = this.route.cum[this.route.cum.length - 1];
    this.traveled = Math.min(total, this.traveled + (this.speed * TICK_MS) / 1000);
    const { pos, heading } = pointAt(this.route.coords, this.route.cum, this.traveled);
    this.onFix({ ...pos, heading, accuracy: 5 });
    if (this.traveled >= total) {
      this.stop();
      this.onDone();
    }
  }
}
