import React, { useState, useEffect } from 'react';
import SetupView from './components/SetupView';
import SimulationView from './components/SimulationView';
import { SimulationInputs, StrategyType, SimulationResult } from './types';
import { runSimulation } from './services/monteCarlo';

type View = 'SETUP' | 'SIMULATION';

const App: React.FC = () => {
  const [view, setView] = useState<View>('SETUP');
  
  // Default inputs
  const [inputs, setInputs] = useState<SimulationInputs>({
    initialCash: 100000,
    initialInvestments: 1150000,
    annualSpend: 65000,
    timeHorizon: 30,
    inflationRate: 3.0,
    managementFee: 0.30, // Updated default to 0.30% which is realistic
    customStockAllocation: 50
  });

  const [selectedStrategy, setSelectedStrategy] = useState<StrategyType>('BUCKET');
  const [results, setResults] = useState<SimulationResult | null>(null);

  const handleRunSimulation = (finalInputs: SimulationInputs) => {
    setInputs(finalInputs); // Update global state
    const res = runSimulation(finalInputs, selectedStrategy);
    setResults(res);
    setView('SIMULATION');
    window.scrollTo(0, 0);
  };

  const handleCustomAllocationChange = (newAlloc: number) => {
    setInputs(prev => {
      const updated = { ...prev, customStockAllocation: newAlloc };
      // Re-run immediately for live slider feeling
      const res = runSimulation(updated, 'CUSTOM');
      setResults(res);
      return updated;
    });
  };

  // If strategy changes in simulation view, re-run
  useEffect(() => {
    if (view === 'SIMULATION') {
      const res = runSimulation(inputs, selectedStrategy);
      setResults(res);
    }
  }, [selectedStrategy, view]); // Removed inputs from dependency to avoid loop, handleCustomAllocationChange handles its own run

  return (
    <>
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
          onRun={() => {
             const res = runSimulation(inputs, selectedStrategy);
             setResults(res);
          }}
          onCustomAllocationChange={handleCustomAllocationChange}
        />
      )}
    </>
  );
};

export default App;