// Headless canvas double.
//
// SS15 keeps every load-bearing thing testable without a browser, but jsdom
// has no `getContext('2d')` at all. This installs a RECORDING 2D context so
// renderer tests can assert the things SS9 actually fixes — dpr scaling,
// half-pixel alignment, per-layer dirty flags — from the call log, instead of
// from pixels nobody can read.

export interface RecordedCall {
  readonly op: string;
  readonly args: readonly unknown[];
}

export interface FakeContext {
  readonly calls: RecordedCall[];
  readonly canvas: HTMLCanvasElement;
  /** Every `op` in order, for coarse assertions. */
  ops(): string[];
  callsOf(op: string): RecordedCall[];
  reset(): void;
}

const RECORDED_METHODS = [
  "save",
  "restore",
  "setTransform",
  "transform",
  "translate",
  "scale",
  "rotate",
  "clearRect",
  "fillRect",
  "strokeRect",
  "beginPath",
  "closePath",
  "moveTo",
  "lineTo",
  "rect",
  "arc",
  "ellipse",
  "quadraticCurveTo",
  "bezierCurveTo",
  "fill",
  "stroke",
  "clip",
  "fillText",
  "strokeText",
  "setLineDash",
  "drawImage",
] as const;

function createFakeContext(canvas: HTMLCanvasElement): FakeContext & Record<string, unknown> {
  const calls: RecordedCall[] = [];
  const ctx: Record<string, unknown> = {
    canvas,
    calls,
    // Painting state the layers read/write; plain properties are enough.
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    globalAlpha: 1,
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    ops: () => calls.map((c) => c.op),
    callsOf: (op: string) => calls.filter((c) => c.op === op),
    reset: () => {
      calls.length = 0;
    },
    measureText: (text: string) => ({ width: text.length * 6 }),
    getLineDash: () => [],
    createLinearGradient: () => ({ addColorStop: () => undefined }),
  };
  for (const op of RECORDED_METHODS) {
    ctx[op] = (...args: unknown[]) => {
      calls.push({ op, args });
    };
  }
  return ctx as FakeContext & Record<string, unknown>;
}

const contexts = new WeakMap<HTMLCanvasElement, FakeContext>();
let installed = false;
let originalGetContext: HTMLCanvasElement["getContext"] | null = null;

/**
 * Patches `HTMLCanvasElement.prototype.getContext`. Idempotent; pair with
 * `uninstallFakeCanvas2D()` in an `afterEach` when a suite needs the real one
 * back (nothing in the kit does).
 */
export function installFakeCanvas2D(): void {
  if (installed) return;
  installed = true;
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  originalGetContext = HTMLCanvasElement.prototype.getContext;
  proto["getContext"] =
    function getContext(this: HTMLCanvasElement, kind: string): unknown {
      if (kind !== "2d") return null;
      const existing = contexts.get(this);
      if (existing !== undefined) return existing;
      const created = createFakeContext(this);
      contexts.set(this, created);
      return created;
    };
}

export function uninstallFakeCanvas2D(): void {
  if (!installed || originalGetContext === null) return;
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto["getContext"] = originalGetContext;
  installed = false;
  originalGetContext = null;
}

/** The recorder behind a canvas, for assertions. */
export function fakeContextOf(canvas: HTMLCanvasElement): FakeContext {
  const ctx = contexts.get(canvas);
  if (ctx === undefined) {
    throw new Error("fakeContextOf: this canvas has no fake 2d context yet");
  }
  return ctx;
}

/** A deterministic rAF pump: nothing draws until `runFrame()` is called. */
export interface ManualFramePump {
  requestFrame: (cb: (time: number) => void) => number;
  cancelFrame: (handle: number) => void;
  /** Runs every callback queued since the last call. Returns how many ran. */
  runFrame(time?: number): number;
  readonly pending: number;
}

export function createManualFramePump(): ManualFramePump {
  let nextHandle = 1;
  const queue = new Map<number, (time: number) => void>();
  return {
    requestFrame: (cb) => {
      const handle = nextHandle++;
      queue.set(handle, cb);
      return handle;
    },
    cancelFrame: (handle) => {
      queue.delete(handle);
    },
    runFrame(time = 0): number {
      const batch = [...queue.values()];
      queue.clear();
      for (const cb of batch) cb(time);
      return batch.length;
    },
    get pending() {
      return queue.size;
    },
  };
}
