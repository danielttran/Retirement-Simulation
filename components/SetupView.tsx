import React, { useState, useEffect } from 'react';
import { SimulationInputs } from '../types';

interface SetupViewProps {
  defaultInputs: SimulationInputs;
  onRun: (inputs: SimulationInputs) => void;
}

// Helper component for formatted numerical inputs
const CurrencyInput = ({ 
  value, 
  onChange, 
  prefix = "", 
  suffix = "" 
}: { 
  value: number; 
  onChange: (val: number) => void; 
  prefix?: string; 
  suffix?: string 
}) => {
  const [displayStr, setDisplayStr] = useState("");
  const [isFocused, setIsFocused] = useState(false);

  // Sync with prop value on mount or external update
  useEffect(() => {
    if (!isFocused) {
      setDisplayStr(value.toLocaleString(undefined, { maximumFractionDigits: 2 }));
    }
  }, [value, isFocused]);

  const handleFocus = () => {
    setIsFocused(true);
    // Show raw number for editing
    setDisplayStr(value.toString());
  };

  const handleBlur = () => {
    setIsFocused(false);
    const parsed = parseFloat(displayStr.replace(/,/g, ''));
    const final = isNaN(parsed) ? 0 : parsed;
    onChange(final);
    setDisplayStr(final.toLocaleString(undefined, { maximumFractionDigits: 2 }));
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Allow user to type anything (including multiple dots) temporarily
    setDisplayStr(e.target.value);
  };

  return (
    <div className="relative flex items-center group">
      {prefix && <span className="absolute left-4 text-slate-400 font-semibold text-xs">{prefix}</span>}
      <input 
        className={`w-full bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 text-slate-800 focus:ring-1 focus:ring-primary focus:border-primary transition-all text-sm font-medium ${prefix ? 'pl-8' : ''} ${suffix ? 'pr-12' : ''}`}
        type="text" 
        value={displayStr}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={handleChange}
      />
      {suffix && <span className="absolute right-4 text-slate-400 font-bold text-[10px] uppercase">{suffix}</span>}
    </div>
  );
};

const SetupView: React.FC<SetupViewProps> = ({ 
  defaultInputs, 
  onRun 
}) => {
  // Local state for the form
  const [formState, setFormState] = useState<SimulationInputs>(defaultInputs);

  // Sync local state ONLY if values truly differ (deep check)
  // This prevents the "resetting while typing" issue if parent re-renders
  useEffect(() => {
    if (JSON.stringify(defaultInputs) !== JSON.stringify(formState)) {
        setFormState(defaultInputs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultInputs]);

  const updateField = (field: keyof SimulationInputs, val: number) => {
    setFormState(prev => ({ ...prev, [field]: val }));
  };

  const handleRunClick = () => {
    onRun(formState);
  };

  return (
    <div className="animate-fade-in">
      <nav className="border-b border-slate-100 bg-white">
        <div className="max-w-7xl mx-auto px-8 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-primary/20 flex items-center justify-center rounded">
              <span className="material-symbols-outlined text-primary text-xl">account_balance_wallet</span>
            </div>
            <span className="text-sm font-bold tracking-widest uppercase text-slate-800">Strategy Lab</span>
          </div>
          <div className="flex items-center gap-8">
            <a href="#" className="text-xs font-semibold text-slate-400 hover:text-slate-900 transition-colors uppercase tracking-widest">Dashboard</a>
            <a href="#" className="text-xs font-semibold text-slate-900 border-b-2 border-primary pb-1 uppercase tracking-widest">Simulation</a>
            <div className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center">
              <span className="material-symbols-outlined text-sm">person</span>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-8 py-20">
        <div className="max-w-3xl mx-auto text-center mb-20">
          <h1 className="font-serif text-5xl text-slate-900 mb-6">Retirement Simulation Setup</h1>
          <p className="text-slate-500 text-lg font-light leading-relaxed">
            Configure your financial parameters. Our engine will simultaneously run multiple strategic scenarios—from cash-bucket approaches to bond-heavy allocations—to find your optimal path.
          </p>
        </div>

        <div className="max-w-4xl mx-auto bg-white rounded-2xl shadow-[0_32px_64px_-16px_rgba(0,0,0,0.05)] border border-slate-100 p-12 relative z-10">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-10">
            {/* Left Column - Assets */}
            <div className="space-y-8">
               <h3 className="text-sm font-bold text-slate-900 border-b border-slate-100 pb-2">Assets</h3>
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Total Cash Savings</label>
                <CurrencyInput 
                  value={formState.initialCash} 
                  onChange={(v) => updateField('initialCash', v)} 
                  prefix="$" 
                  suffix="USD"
                />
                <p className="text-[10px] text-slate-400 mt-2">Cash, Savings, CDs, and other liquid equivalents.</p>
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Investment Portfolio</label>
                <CurrencyInput 
                  value={formState.initialInvestments} 
                  onChange={(v) => updateField('initialInvestments', v)} 
                  prefix="$" 
                  suffix="USD"
                />
                <p className="text-[10px] text-slate-400 mt-2">Total value of Stocks, Bonds, ETFs, and Mutual Funds.</p>
              </div>
            </div>

            {/* Right Column - Variables */}
            <div className="space-y-8">
              <h3 className="text-sm font-bold text-slate-900 border-b border-slate-100 pb-2">Variables</h3>
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Annual Retirement Spending</label>
                <CurrencyInput 
                  value={formState.annualSpend} 
                  onChange={(v) => updateField('annualSpend', v)} 
                  prefix="$" 
                  suffix="USD"
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Simulation Time Horizon</label>
                <div className="flex items-center gap-4">
                  <input 
                    className="w-full h-1 bg-slate-200 accent-primary rounded-lg appearance-none cursor-pointer" 
                    max="50" min="5" 
                    type="range" 
                    value={formState.timeHorizon}
                    onChange={(e) => updateField('timeHorizon', parseInt(e.target.value))}
                  />
                  <span className="text-sm font-bold text-slate-800 w-16 text-right">{formState.timeHorizon} Years</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Inflation Rate</label>
                  <CurrencyInput 
                    value={formState.inflationRate} 
                    onChange={(v) => updateField('inflationRate', v)} 
                    suffix="%"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Management Fee</label>
                  <CurrencyInput 
                    value={formState.managementFee} 
                    onChange={(v) => updateField('managementFee', v)} 
                    suffix="%"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="mt-16 flex flex-col items-center">
            <button 
              onClick={handleRunClick}
              className="group relative bg-slate-900 text-white px-20 py-5 rounded-full font-bold text-lg hover:bg-slate-800 transition-all shadow-xl shadow-slate-200 overflow-hidden"
            >
              <span className="relative z-10">Run Simulation</span>
              <div className="absolute inset-0 bg-primary/10 scale-x-0 group-hover:scale-x-100 transition-transform origin-left"></div>
            </button>
            <p className="mt-6 text-[10px] font-bold text-slate-300 uppercase tracking-[0.2em]">Generates 4 Strategic Scenarios</p>
          </div>
          
          <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 flex gap-1">
            <div className="w-1 h-1 rounded-full bg-slate-200"></div>
            <div className="w-1 h-1 rounded-full bg-slate-200"></div>
            <div className="w-1 h-1 rounded-full bg-slate-200"></div>
          </div>
        </div>

        {/* Educational Content Section */}
        <div className="max-w-4xl mx-auto mt-20 pt-10 border-t border-slate-200">
           <h3 className="text-xl font-serif text-slate-900 mb-8 text-center">Understanding the Simulation Model</h3>
           <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
              <div className="bg-white p-8 rounded-xl border border-slate-100 shadow-sm">
                <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center mb-4">
                  <span className="material-symbols-outlined text-primary">function</span>
                </div>
                <h4 className="font-bold text-slate-900 mb-2">What is Monte Carlo?</h4>
                <p className="text-sm text-slate-500 leading-relaxed">
                  Instead of assuming a steady return (e.g., 7% every year), a Monte Carlo simulation uses random sampling to generate thousands of possible market scenarios based on historical volatility. This helps identify the probability of running out of money in "worst-case" scenarios.
                </p>
              </div>
              <div className="bg-white p-8 rounded-xl border border-slate-100 shadow-sm">
                 <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center mb-4">
                  <span className="material-symbols-outlined text-primary">tune</span>
                </div>
                <h4 className="font-bold text-slate-900 mb-2">Why Strategy Matters?</h4>
                <p className="text-sm text-slate-500 leading-relaxed">
                  The allocation between Stocks (growth) and Bonds (stability) determines your portfolio's resilience. The <strong>Bucket Strategy</strong> is unique: it keeps 2 years of cash on hand to avoid selling stocks during market crashes, potentially increasing longevity.
                </p>
              </div>
           </div>
        </div>
      </main>

      <footer className="max-w-7xl mx-auto px-8 py-16 border-t border-slate-50 mt-20 flex flex-col md:flex-row justify-between items-center gap-6">
        <p className="text-slate-400 text-[10px] font-medium uppercase tracking-widest">© 2024 Strategy Lab • Private & Confidential Financial Simulation</p>
      </footer>
    </div>
  );
};

export default SetupView;