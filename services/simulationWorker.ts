/**
 * Web Worker entry point for the Monte Carlo simulation engine.
 *
 * Offloads the synchronous (CPU-bound) `runSimulation` call off the main thread
 * so the loading overlay and the rest of the React UI remain fully responsive
 * during the ~10–20 second 100,000-scenario run.
 *
 * Message protocol
 * ─────────────────
 * Incoming  { inputs: SimulationInputs; strategy: StrategyType }
 * Outgoing  { type: 'result';  result: SimulationResult }
 *         | { type: 'error';   message: string }
 *
 * Instantiate in the host with Vite's module-worker syntax:
 *   new Worker(new URL('./services/simulationWorker.ts', import.meta.url), { type: 'module' })
 */

import { runSimulation } from './monteCarlo';
import type { SimulationInputs, StrategyType, SimulationResult } from '../types';

interface WorkerRequest {
  inputs: SimulationInputs;
  strategy: StrategyType;
}

interface WorkerResultMessage {
  type: 'result';
  result: SimulationResult;
}

interface WorkerErrorMessage {
  type: 'error';
  message: string;
}

type WorkerOutMessage = WorkerResultMessage | WorkerErrorMessage;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  try {
    const result = runSimulation(e.data.inputs, e.data.strategy);
    const msg: WorkerOutMessage = { type: 'result', result };
    self.postMessage(msg);
  } catch (err) {
    const msg: WorkerOutMessage = {
      type: 'error',
      message: err instanceof Error ? err.message : 'Unexpected simulation error.',
    };
    self.postMessage(msg);
  }
};
