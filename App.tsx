import React, { useState, useEffect, useCallback } from 'react';
import SetupView from './components/SetupView';
import SimulationView from './components/SimulationView';
import { SimulationInputs, StrategyType, SimulationResult } from './types';
import { runSimulation } from './services/monteCarlo';

type View = 'SETUP' | 'SIMULATION';

// Loading overlay component
const LoadingOverlay: React.FC = () => (
  <div className="fixed inset-0 z-[9999] bg-background-light/80 backdrop-blur-sm flex items-center justify-center">
    <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-10 flex flex-col items-center gap-4">
      <div className="w-10 h-10 border-4 border-slate-200 border-t-primary rounded-full animate-spin" />
      <p className="text-sm font-bold text-slate-700">Running Simulation</p>
      <p className="text-[11px] text-slate-400 uppercase tracking-wider font-semibold">10,000 Scenarios</p>
    </div>
  </div>
);

const App: React.FC = () => {
  const [view, setView] = useState<View>('SETUP');
  const [isSimulating, setIsSimulating] = useState(false);

  // Default inputs
  const [inputs, setInputs] = useState<SimulationInputs>({
    initialCash: 10000,
    initialInvestments: 500000,
    annualSpend: 30000,
    timeHorizon: 30,
    inflationRate: 3.0,
    managementFee: 0.30,
    customStockAllocation: 50
  });

  const [selectedStrategy, setSelectedStrategy] = useState<StrategyType>('BUCKET');
  const [results, setResults] = useState<SimulationResult | null>(null);

  // Deferred simulation runner — yields to the main thread so loading UI renders
  const runSimulationAsync = useCallback((simInputs: SimulationInputs, strategy: StrategyType, onComplete?: () => void) => {
    setIsSimulating(true);
    // setTimeout(0) yields to the browser so the loading overlay paints
    setTimeout(() => {
      try {
        const res = runSimulation(simInputs, strategy);
        setResults(res);
      } catch (err) {
        console.error('Simulation error:', err);
      } finally {
        setIsSimulating(false);
        onComplete?.();
      }
    }, 50);
  }, []);

  const handleRunSimulation = (finalInputs: SimulationInputs) => {
    setInputs(finalInputs);
    runSimulationAsync(finalInputs, selectedStrategy, () => {
      setView('SIMULATION');
      window.scrollTo(0, 0);
    });
  };

  const handleCustomAllocationChange = (newAlloc: number) => {
    setInputs(prev => {
      const updated = { ...prev, customStockAllocation: newAlloc };
      // Re-run immediately for live slider feeling (no loading overlay for this)
      const res = runSimulation(updated, 'CUSTOM');
      setResults(res);
      return updated;
    });
  };

  // If strategy changes in simulation view, re-run
  useEffect(() => {
    if (view === 'SIMULATION') {
      runSimulationAsync(inputs, selectedStrategy);
    }
  }, [selectedStrategy]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      {isSimulating && <LoadingOverlay />}

      {view === 'SETUP' && (
        <SetupView
          defaultInputs={inputs}
          onRun={handleRunSimulation}
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
        />
      )}
    </>
  );
};

export default App;