import React, { useState, useEffect, useCallback, useRef } from 'react';
import SetupView from './components/SetupView';
import SimulationView from './components/SimulationView';
import { SimulationInputs, StrategyType, SimulationResult } from './types';
// runSimulation is no longer called directly on the main thread.
// It runs inside a dedicated Web Worker so the UI stays responsive during the
// 100,000-scenario Monte Carlo pass (~10–20 s).
// The worker is instantiated lazily (once per session) inside runSimulationAsync.

type View = 'SETUP' | 'SIMULATION';

// Loading overlay component
const LoadingOverlay: React.FC = () => (
  <div className="fixed inset-0 z-[9999] bg-background-light/80 dark:bg-background-dark/80 backdrop-blur-sm flex items-center justify-center">
    <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-800 p-10 flex flex-col items-center gap-4">
      <div className="w-10 h-10 border-4 border-slate-200 dark:border-slate-700 border-t-primary rounded-full animate-spin" />
      <p className="text-sm font-bold text-slate-700 dark:text-slate-300">Running Simulation</p>
      <p className="text-[11px] text-slate-400 dark:text-slate-500 uppercase tracking-wider font-semibold">100,000 Scenarios</p>
    </div>
  </div>
);

const App: React.FC = () => {
  const [view, setView] = useState<View>('SETUP');
  const [isSimulating, setIsSimulating] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('theme');
    return saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches);
  });

  // Apply theme class to document
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }, [isDarkMode]);

  // Default inputs, with localStorage hydration
  const [inputs, setInputs] = useState<SimulationInputs>(() => {
    const saved = localStorage.getItem('simulationInputs');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.expectedStockReturn === undefined) {
          parsed.expectedStockReturn = 8.5;
        }
        return parsed;
      } catch (e) {
        console.error('Failed to parse cached inputs:', e);
      }
    }
    return {
      initialCash: 10000,
      initialInvestments: 400000,
      spendingPhases: [{ id: 1, startYear: 0, endYear: 30, annualSpend: 30000 }],
      timeHorizon: 40,
      inflationRate: 3.0,
      expectedStockReturn: 8.5,
      managementFee: 0.10,
      customStockAllocation: 50,
      // CPA-grade defaults: typical pre-retiree profile
      currentAge: 65,
      taxDeferredRatio: 80,  // 80% in Traditional IRA/401(k) is common for US retirees
      withdrawalTaxRate: 22, // 22% federal marginal bracket (2024 MFJ: $94k–$201k)
      birthYear: 1961, // matches currentAge: 65 in 2026 (2026 − 65 = 1961)
      socialSecurityIncome: 1200,
      socialSecurityAge: 67,
      // Scenario band percentiles — which Monte Carlo percentile each chart line represents.
      percentileAverage: 50,
      percentileBelowAverage: 25,
      percentileDownturn: 10,
    };
  });

  // Update cache whenever inputs change
  useEffect(() => {
    localStorage.setItem('simulationInputs', JSON.stringify(inputs));
  }, [inputs]);

  const [selectedStrategy, setSelectedStrategy] = useState<StrategyType>('BUCKET');
  const [results, setResults] = useState<SimulationResult | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);

  // Debounce ref for the live custom-allocation slider so we don't block the
  // main thread on every slider tick.
  const sliderDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirror of `inputs` in a ref so the debounced slider callback can read the
  // latest state without capturing a stale closure and without using the
  // `setInputs` functional updater as an impure reader (which React 18 Strict
  // Mode would call twice, triggering double simulation runs).
  const latestInputsRef = useRef<SimulationInputs>(inputs);
  useEffect(() => { latestInputsRef.current = inputs; }, [inputs]);

  // Persistent Web Worker ref — created once, reused for every simulation call.
  // A single worker is sufficient because we only run one simulation at a time;
  // any in-flight run is implicitly superseded when the user triggers a new one
  // (the prior result is discarded when the new message arrives).
  const workerRef = useRef<Worker | null>(null);
  const getWorker = useCallback((): Worker => {
    if (!workerRef.current) {
      // Vite module-worker syntax: the bundler co-locates the worker chunk and
      // resolves the URL at build time. `{ type: 'module' }` enables ES module
      // imports inside the worker (required for the monteCarlo.ts import).
      workerRef.current = new Worker(
        new URL('./services/simulationWorker.ts', import.meta.url),
        { type: 'module' }
      );
    }
    return workerRef.current;
  }, []);

  // Simulation runner — dispatches work to the Web Worker so the main thread
  // (and loading overlay animation) remain responsive during the 100k-scenario run.
  const runSimulationAsync = useCallback((simInputs: SimulationInputs, strategy: StrategyType, onComplete?: () => void) => {
    setIsSimulating(true);
    setSimulationError(null);

    // Terminate any in-flight worker so a stale slow run cannot overwrite the
    // result of a newer run that completes first.  Termination is instant; the
    // next getWorker() call creates a fresh instance.
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }

    const worker = getWorker();

    // Replace the message handler for this invocation (handles superseded runs).
    worker.onmessage = (e: MessageEvent) => {
      const { type } = e.data;
      if (type === 'result') {
        setResults(e.data.result);
        // Only navigate / notify on success — mirrors the previous behaviour where
        // onComplete was not called inside `finally` to avoid stale-result navigation.
        onComplete?.();
      } else {
        console.error('Simulation worker error:', e.data.message);
        setSimulationError(e.data.message ?? 'Unexpected simulation error.');
      }
      setIsSimulating(false);
    };

    worker.onerror = (err) => {
      console.error('Simulation worker uncaught error:', err);
      setSimulationError(err.message ?? 'Unexpected simulation error.');
      setIsSimulating(false);
    };

    worker.postMessage({ inputs: simInputs, strategy });
  }, [getWorker]);

  const handleRunSimulation = (finalInputs: SimulationInputs) => {
    setInputs(finalInputs);
    runSimulationAsync(finalInputs, selectedStrategy, () => {
      setView('SIMULATION');
      window.scrollTo(0, 0);
    });
  };

  const handleCustomAllocationChange = useCallback((newAlloc: number) => {
    // Immediately update the displayed slider value (cheap — no simulation).
    setInputs(prev => ({ ...prev, customStockAllocation: newAlloc }));

    // Debounce the expensive 100,000-scenario re-run so rapid slider drags don't
    // queue up many overlapping worker dispatches.
    if (sliderDebounceRef.current) clearTimeout(sliderDebounceRef.current);
    sliderDebounceRef.current = setTimeout(() => {
      // Use the ref (not a closure over `inputs`) to guarantee we read the
      // most-recent state without triggering the Strict Mode double-invoke issue.
      runSimulationAsync(
        { ...latestInputsRef.current, customStockAllocation: newAlloc },
        'CUSTOM'
      );
    }, 150);
  }, [runSimulationAsync]);

  // If strategy changes in simulation view, re-run
  useEffect(() => {
    if (view === 'SIMULATION') {
      runSimulationAsync(inputs, selectedStrategy);
    }
  }, [selectedStrategy]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {isSimulating && <LoadingOverlay />}

      {/* Non-blocking error toast — appears when runSimulation throws without crashing the app */}
      {simulationError && (
        <div className="fixed bottom-4 right-4 z-[9999] bg-red-50 dark:bg-red-950/80 border border-red-200 dark:border-red-800 rounded-xl p-4 max-w-sm shadow-xl backdrop-blur-sm">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-red-500 text-xl mt-0.5">error</span>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-red-700 dark:text-red-400 mb-1">Simulation Error</p>
              <p className="text-[11px] text-red-600 dark:text-red-400 leading-relaxed break-words">{simulationError}</p>
            </div>
            <button
              onClick={() => setSimulationError(null)}
              className="text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors shrink-0"
              aria-label="Dismiss error"
            >
              <span className="material-symbols-outlined text-base">close</span>
            </button>
          </div>
        </div>
      )}

      {view === 'SETUP' && (
        <SetupView
          defaultInputs={inputs}
          onRun={handleRunSimulation}
          isDarkMode={isDarkMode}
          onToggleDarkMode={() => setIsDarkMode(!isDarkMode)}
        />
      )}

      {view === 'SIMULATION' && results && (
        <SimulationView
          inputs={inputs}
          results={results}
          selectedStrategy={selectedStrategy}
          setSelectedStrategy={setSelectedStrategy}
          onEdit={() => setView('SETUP')}
          onRun={() => runSimulationAsync(inputs, selectedStrategy)}
          onCustomAllocationChange={handleCustomAllocationChange}
          isDarkMode={isDarkMode}
          onToggleDarkMode={() => setIsDarkMode(!isDarkMode)}
        />
      )}
    </>
  );
};

export default App;