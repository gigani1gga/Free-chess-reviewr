// Lets the app's real js/engine.js run in Node: gives it a `Worker` that is really a Stockfish process (native, npm build or mock).
import { UciProc } from './uci.mjs';

export function installWorker(spec) {
  const procs = [];
  globalThis.Worker = class {
    constructor() {
      this.proc = new UciProc(spec);
      procs.push(this.proc);
      this.proc.onLine = line => this.onmessage?.({ data: line });
      this.proc.onExit = ex => { if (ex.code) this.onerror?.(new Error('engine exited with code ' + ex.code)); };
      this.proc.p.on('error', e => this.onerror?.(e));
    }
    postMessage(cmd) { this.proc.send(String(cmd)); }
    terminate() { this.proc.kill(); }
  };
  return { procs };
}
