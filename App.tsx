import React, { useState, useEffect, useCallback, useRef } from 'react';
import SetupView from './components/SetupView';
import SimulationView from './components/SimulationView';
import { SimulationInputs, StrategyType, SimulationResult } from './types';
// runSimulation is no longer called directly on the main thread.
// It runs inside a dedicated Web Worker so the UI stays responsive during the
// 100,000-scenario Monte Carlo pass (~10–20 s).
// The worker is instantiated lazily (once per session) inside runSimulationAsync.

type View = 'SETUP' | 'SIMULATION';
type RawSpendingPhase = Partial<{
  id: number;
  startYear: number;
  endYear: number;
  annualSpend: number;
}>;

const clampNumber = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const clampCustomAllocations = (stock: number, cash: number) => {
  const safeStock = Math.round(clampNumber(stock, 0, 100, 0));
  const safeCash = Math.round(clampNumber(cash, 0, 100, 0));
  if (safeStock + safeCash <= 100) return { stock: safeStock, cash: safeCash };
  return { stock: safeStock, cash: Math.max(0, 100 - safeStock) };
};

const sanitizeSpendingPhases = (rawPhases: unknown, horizon: number) => {
  const safeHorizon = Math.max(1, Math.floor(Number(horizon) || 1));
  const fallback = [{ id: 1, startYear: 0, endYear: safeHorizon, annualSpend: 30000 }];
  const withStableIds = <T extends { id: number }>(phases: T[]) =>
    phases.map((phase, index) => ({ ...phase, id: index + 1 }));
  if (!Array.isArray(rawPhases) || rawPhases.length === 0) return fallback;

  const parsed = (rawPhases as RawSpendingPhase[])
    .map((phase, index) => ({
      id: Number.isFinite(phase?.id) ? Number(phase.id) : index + 1,
      startYear: Math.max(0, Math.floor(Number(phase?.startYear) || 0)),
      endYear: Math.max(1, Math.floor(Number(phase?.endYear) || safeHorizon)),
      annualSpend: Math.max(0, Number(phase?.annualSpend) || 0),
    }))
    .sort((a, b) => a.startYear - b.startYear);

  if (parsed.length === 0) return fallback;

  const normalized: typeof parsed = [];
  for (let i = 0; i < parsed.length; i++) {
    const phase = parsed[i];
    const prev = normalized[i - 1];
    const startYear = i === 0 ? 0 : Math.max(phase.startYear, prev.startYear + 1);
    const maxEnd = i === parsed.length - 1 ? safeHorizon : safeHorizon - (parsed.length - i - 1);
    const endYear = Math.max(startYear + 1, Math.min(maxEnd, phase.endYear));
    normalized.push({ ...phase, startYear, endYear });
  }

  const withinHorizon = normalized.filter((p) => p.startYear < safeHorizon);
  if (withinHorizon.length === 0) return fallback;

  for (let i = 1; i < withinHorizon.length; i++) {
    withinHorizon[i].startYear = withinHorizon[i - 1].endYear;
    if (withinHorizon[i].endYear <= withinHorizon[i].startYear) {
      withinHorizon[i].endYear = Math.min(safeHorizon, withinHorizon[i].startYear + 1);
    }
  }
  withinHorizon[withinHorizon.length - 1].endYear = safeHorizon;
  return withStableIds(withinHorizon);
};

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
    const defaults: SimulationInputs = {
      initialCash: 10000,
      initialInvestments: 400000,
      spendingPhases: [{ id: 1, startYear: 0, endYear: 40, annualSpend: 30000 }],
      timeHorizon: 40,
      inflationRate: 3.0,
      expectedStockReturn: 8.5,
      expectedBondReturn: 4.0,
      expectedCashReturn: 2.5,
      expectedStockVolatility: 17.0,
      managementFee: 0.10,
      customStockAllocation: 50,
      customCashAllocation: 0,
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
      // Early-retirement + healthcare defaults (Simple Mode safe).
      rothRatio: 10,
      useSEPP: false,
      seppRate: 5.0,
      includeHealthcare: false,
    };

    const saved = localStorage.getItem('simulationInputs');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Merge with defaults so that any newly added fields (CPA/Tax/SS) are 
        // present even if the user has an old cache from a previous version.
        const merged = { ...defaults, ...parsed };
        const safeHorizon = Math.floor(clampNumber(merged.timeHorizon, 5, 50, defaults.timeHorizon));
        const percentileAverage = Math.round(clampNumber(merged.percentileAverage, 3, 99, defaults.percentileAverage));
        const percentileBelowAverage = Math.min(
          percentileAverage - 1,
          Math.round(clampNumber(merged.percentileBelowAverage, 2, 98, defaults.percentileBelowAverage))
        );
        const percentileDownturn = Math.min(
          percentileBelowAverage - 1,
          Math.round(clampNumber(merged.percentileDownturn, 1, 97, defaults.percentileDownturn))
        );
        const customAllocations = clampCustomAllocations(merged.customStockAllocation, merged.customCashAllocation);
        return {
          ...merged,
          timeHorizon: safeHorizon,
          initialCash: clampNumber(merged.initialCash, 0, Number.MAX_SAFE_INTEGER, defaults.initialCash),
          initialInvestments: clampNumber(merged.initialInvestments, 0, Number.MAX_SAFE_INTEGER, defaults.initialInvestments),
          inflationRate: clampNumber(merged.inflationRate, 0, 15, defaults.inflationRate),
          expectedStockReturn: clampNumber(merged.expectedStockReturn, 0, 30, defaults.expectedStockReturn),
          expectedBondReturn: clampNumber(merged.expectedBondReturn, 0, 20, defaults.expectedBondReturn),
          expectedCashReturn: clampNumber(merged.expectedCashReturn, 0, 15, defaults.expectedCashReturn),
          expectedStockVolatility: clampNumber(merged.expectedStockVolatility, 1, 60, defaults.expectedStockVolatility),
          managementFee: clampNumber(merged.managementFee, 0, 5, defaults.managementFee),
          customStockAllocation: customAllocations.stock,
          customCashAllocation: customAllocations.cash,
          currentAge: Math.round(clampNumber(merged.currentAge, 25, 85, defaults.currentAge)),
          taxDeferredRatio: clampNumber(merged.taxDeferredRatio, 0, 100, defaults.taxDeferredRatio),
          withdrawalTaxRate: clampNumber(merged.withdrawalTaxRate, 0, 60, defaults.withdrawalTaxRate),
          birthYear: Math.round(clampNumber(merged.birthYear, 1900, new Date().getFullYear(), defaults.birthYear)),
          socialSecurityIncome: clampNumber(merged.socialSecurityIncome, 0, Number.MAX_SAFE_INTEGER, defaults.socialSecurityIncome),
          socialSecurityAge: Math.round(clampNumber(merged.socialSecurityAge, 50, 85, defaults.socialSecurityAge)),
          percentileAverage,
          percentileBelowAverage: Math.max(2, percentileBelowAverage),
          percentileDownturn: Math.max(1, percentileDownturn),
          // Roth + Traditional combined cap of 100; trim Roth if needed.
          rothRatio: Math.min(
            Math.max(0, 100 - clampNumber(merged.taxDeferredRatio, 0, 100, defaults.taxDeferredRatio)),
            clampNumber(merged.rothRatio, 0, 100, defaults.rothRatio)
          ),
          useSEPP: Boolean(merged.useSEPP),
          seppRate: clampNumber(merged.seppRate, 0, 12, defaults.seppRate),
          includeHealthcare: Boolean(merged.includeHealthcare),
          spendingPhases: sanitizeSpendingPhases(merged.spendingPhases, safeHorizon),
        };
      } catch (e) {
        console.error('Failed to parse cached inputs:', e);
      }
    }
    return defaults;
  });

  // Update cache whenever inputs change
  useEffect(() => {
    localStorage.setItem('simulationInputs', JSON.stringify(inputs));
  }, [inputs]);

  const [selectedStrategy, setSelectedStrategy] = useState<StrategyType>('BUCKET');
  const [allResults, setAllResults] = useState<Partial<Record<StrategyType, SimulationResult>>>({});
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const selectedResult = allResults[selectedStrategy] ?? null;
  const [lastVisibleResults, setLastVisibleResults] = useState<Partial<Record<StrategyType, SimulationResult>>>({});
  const renderResult = selectedResult ?? lastVisibleResults[selectedStrategy] ?? null;

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
  const runningIdRef = useRef<number>(0);
  const compareRunInFlightRef = useRef(false);
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
  const runSimulationAsync = useCallback((simInputs: SimulationInputs, strategy: StrategyType): Promise<boolean> => {
    setIsSimulating(true);
    setSimulationError(null);

    runningIdRef.current += 1;
    const currentRunId = runningIdRef.current;
    const worker = getWorker();

    return new Promise<boolean>((resolve) => {
      // Replace the message handler for this invocation (handles superseded runs).
      worker.onmessage = (e: MessageEvent<{ type: 'result' | 'error'; requestId: number; result?: SimulationResult; message?: string }>) => {
        if (e.data.requestId !== runningIdRef.current || currentRunId !== runningIdRef.current) return;
        const { type } = e.data;
        if (type === 'result') {
          if (!e.data.result) {
            setSimulationError('Simulation worker returned an empty result payload.');
            setIsSimulating(false);
            resolve(false);
            return;
          }
          setAllResults(prev => ({ ...prev, [strategy]: e.data.result }));
          setIsSimulating(false);
          resolve(true);
          return;
        }

        console.error('Simulation worker error:', e.data.message);
        setSimulationError(e.data.message ?? 'Unexpected simulation error.');
        setIsSimulating(false);
        resolve(false);
      };

      worker.onerror = (err) => {
        if (currentRunId !== runningIdRef.current) return;
        console.error('Simulation worker uncaught error:', err);
        setSimulationError(err.message ?? 'Unexpected simulation error.');
        setIsSimulating(false);
        resolve(false);
      };

      worker.postMessage({ requestId: currentRunId, inputs: simInputs, strategy });
    });
  }, [getWorker]);

  const handleRunSimulation = (finalInputs: SimulationInputs) => {
    // New setup run implies a new scenario baseline; clear prior strategy results
    // so Compare view cannot mix stale outputs from older assumptions.
    setAllResults({});
    setLastVisibleResults({});
    setInputs(finalInputs);
    void runSimulationAsync(finalInputs, selectedStrategy).then((wasSuccessful) => {
      if (!wasSuccessful) return;
      setView('SIMULATION');
      window.scrollTo(0, 0);
    });
  };

  const handleCustomAllocationChange = useCallback((newAlloc: number) => {
    const boundedStock = Math.round(clampNumber(newAlloc, 0, 100, 0));
    const boundedCash = Math.min(latestInputsRef.current.customCashAllocation, Math.max(0, 100 - boundedStock));
    const nextInputs = {
      ...latestInputsRef.current,
      customStockAllocation: boundedStock,
      customCashAllocation: boundedCash,
    };
    setAllResults({});
    setLastVisibleResults({});
    // Immediately update the displayed slider value (cheap — no simulation).
    setInputs(nextInputs);

    // Debounce the expensive 100,000-scenario re-run so rapid slider drags don't
    // queue up many overlapping worker dispatches.
    if (sliderDebounceRef.current) clearTimeout(sliderDebounceRef.current);
    sliderDebounceRef.current = setTimeout(() => {
      // Use the ref (not a closure over `inputs`) to guarantee we read the
      // most-recent state without triggering the Strict Mode double-invoke issue.
      void runSimulationAsync(
        nextInputs,
        'CUSTOM'
      );
    }, 150);
  }, [runSimulationAsync]);

  const handleCustomCashAllocationChange = useCallback((newAlloc: number) => {
    const maxCash = Math.max(0, 100 - latestInputsRef.current.customStockAllocation);
    const boundedCash = Math.round(clampNumber(newAlloc, 0, maxCash, 0));
    const nextInputs = {
      ...latestInputsRef.current,
      customCashAllocation: boundedCash,
    };
    setAllResults({});
    setLastVisibleResults({});
    setInputs(nextInputs);
    if (sliderDebounceRef.current) clearTimeout(sliderDebounceRef.current);
    sliderDebounceRef.current = setTimeout(() => {
      void runSimulationAsync(nextInputs, 'CUSTOM');
    }, 150);
  }, [runSimulationAsync]);

  // If strategy changes in simulation view, run only when that strategy is not cached.
  useEffect(() => {
    if (view === 'SIMULATION' && !allResults[selectedStrategy]) {
      void runSimulationAsync(inputs, selectedStrategy);
    }
  }, [selectedStrategy, view, inputs, allResults, runSimulationAsync]);

  useEffect(() => {
    if (selectedResult) {
      setLastVisibleResults((prev) => ({ ...prev, [selectedStrategy]: selectedResult }));
    }
  }, [selectedResult, selectedStrategy]);

  const handleCompareAll = useCallback(async () => {
    if (compareRunInFlightRef.current) return;
    compareRunInFlightRef.current = true;
    const strategies: StrategyType[] = ['BUCKET', 'CONSERVATIVE', 'AGGRESSIVE', 'CUSTOM'];
    try {
      for (const strategy of strategies) {
        if (allResults[strategy]) continue;
        const ok = await runSimulationAsync(inputs, strategy);
        if (!ok) break;
      }
    } finally {
      compareRunInFlightRef.current = false;
    }
  }, [allResults, inputs, runSimulationAsync]);

  useEffect(() => {
    return () => {
      if (sliderDebounceRef.current) clearTimeout(sliderDebounceRef.current);
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

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
          hasResult={Object.keys(allResults).length > 0}
          onShowResult={() => {
            setView('SIMULATION');
            window.scrollTo(0, 0);
          }}
        />
      )}

      {view === 'SIMULATION' && renderResult && (
        <SimulationView
          inputs={inputs}
          results={renderResult}
          allResults={allResults}
          selectedStrategy={selectedStrategy}
          setSelectedStrategy={setSelectedStrategy}
          onCompareAll={handleCompareAll}
          onEdit={() => setView('SETUP')}
          onRun={() => { void runSimulationAsync(inputs, selectedStrategy); }}
          onCustomAllocationChange={handleCustomAllocationChange}
          onCustomCashAllocationChange={handleCustomCashAllocationChange}
          isDarkMode={isDarkMode}
          onToggleDarkMode={() => setIsDarkMode(!isDarkMode)}
        />
      )}
    </>
  );
};

export default App;
