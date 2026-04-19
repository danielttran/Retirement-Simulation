/**
 * Web Worker entry point for the Monte Carlo simulation engine.
 *
 * Offloads the synchronous (CPU-bound) `runSimulation` call off the main thread
 * so the loading overlay and the rest of the React UI remain fully responsive
 * during the ~10–20 second 100,000-scenario run.
 *
 * Message protocol
 * ─────────────────
 * Incoming  { requestId: number; inputs: SimulationInputs; strategy: StrategyType }
 * Outgoing  { type: 'result'; requestId: number; result: SimulationResult }
 *         | { type: 'error';  requestId: number; message: string }
 *
 * Instantiate in the host with Vite's module-worker syntax:
 *   new Worker(new URL('./services/simulationWorker.ts', import.meta.url), { type: 'module' })
 */

import { runSimulation } from './monteCarlo';
import type { SimulationInputs, StrategyType, SimulationResult } from '../types';

interface WorkerRequest {
  requestId: number;
  inputs: SimulationInputs;
  strategy: StrategyType;
}

interface WorkerResultMessage {
  type: 'result';
  requestId: number;
  result: SimulationResult;
}

interface WorkerErrorMessage {
  type: 'error';
  requestId: number;
  message: string;
}

type WorkerOutMessage = WorkerResultMessage | WorkerErrorMessage;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { requestId, inputs, strategy } = e.data;
  try {
    const result = runSimulation(inputs, strategy);
    const msg: WorkerOutMessage = { type: 'result', requestId, result };
    self.postMessage(msg);
  } catch (err) {
    const msg: WorkerOutMessage = {
      type: 'error',
      requestId,
      message: err instanceof Error ? err.message : 'Unexpected simulation error.',
    };
    self.postMessage(msg);
  }
};
