import React, { useState, useEffect } from 'react';
import { SimulationInputs, SpendingPhase } from '../types';

interface SetupViewProps {
  defaultInputs: SimulationInputs;
  onRun: (inputs: SimulationInputs) => void;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
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
    setDisplayStr(value.toString());
  };

  const handleBlur = () => {
    setIsFocused(false);
    const parsed = parseFloat(displayStr.replace(/,/g, ''));
    // Guard against NaN and Infinity — both would poison the Monte Carlo engine.
    const final = isNaN(parsed) || !isFinite(parsed) ? 0 : parsed;
    onChange(final);
    setDisplayStr(final.toLocaleString(undefined, { maximumFractionDigits: 2 }));
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDisplayStr(e.target.value);
  };

  return (
    <div className="relative flex items-center group">
      {prefix && <span className="absolute left-4 text-slate-400 dark:text-slate-500 font-semibold text-xs">{prefix}</span>}
      <input
        className={`w-full bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 text-slate-800 dark:text-slate-100 focus:ring-1 focus:ring-primary focus:border-primary transition-all text-sm font-medium ${prefix ? 'pl-8' : ''} ${suffix ? 'pr-12' : ''}`}
        type="text"
        value={displayStr}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onChange={handleChange}
      />
      {suffix && <span className="absolute right-4 text-slate-400 dark:text-slate-500 font-bold text-[10px] uppercase">{suffix}</span>}
    </div>
  );
};

// ─── Spending Phases Editor ───────────────────────────────────────────────────

const PHASE_COLORS = ['#3b82f6', '#22c55e', '#ef4444', '#f59e0b', '#8b5cf6', '#06b6d4'];
const PHASE_BG = [
  'bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800/40',
  'bg-green-50 dark:bg-green-900/20 border border-green-100 dark:border-green-800/40',
  'bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800/40',
  'bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800/40',
  'bg-violet-50 dark:bg-violet-900/20 border border-violet-100 dark:border-violet-800/40',
  'bg-cyan-50 dark:bg-cyan-900/20 border border-cyan-100 dark:border-cyan-800/40',
];

interface SpendingPhasesEditorProps {
  phases: SpendingPhase[];
  timeHorizon: number;
  onChange: (phases: SpendingPhase[]) => void;
}

const SpendingPhasesEditor: React.FC<SpendingPhasesEditorProps> = ({ phases, timeHorizon, onChange }) => {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftSpend, setDraftSpend] = useState<number>(0);
  const [draftStartYear, setDraftStartYear] = useState<string>('');
  const [draftEndYear, setDraftEndYear] = useState<string>('');

  const handleAdd = () => {
    const last = phases[phases.length - 1];
    let newStart;
    let modifiedLast = { ...last };

    if (last.endYear < timeHorizon) {
      newStart = last.endYear;
    } else {
      const duration = last.endYear - last.startYear;
      if (duration < 2) return;
      newStart = last.startYear + Math.floor(duration / 2);
      modifiedLast.endYear = newStart;
    }

    const newId = Math.max(...phases.map(p => p.id)) + 1;
    onChange([
      ...phases.slice(0, -1),
      modifiedLast,
      { id: newId, startYear: newStart, endYear: timeHorizon, annualSpend: last.annualSpend },
    ]);
  };

  const handleDelete = (id: number) => {
    if (phases.length === 1) return;
    const idx = phases.findIndex(p => p.id === id);
    const updated = phases.filter(p => p.id !== id);
    if (idx === 0) {
      updated[0] = { ...updated[0], startYear: 0 };
    } else {
      updated[idx - 1] = { ...updated[idx - 1], endYear: phases[idx].endYear };
    }
    onChange(updated);
    if (editingId === id) setEditingId(null);
  };

  const openEdit = (phase: SpendingPhase) => {
    setEditingId(phase.id);
    setDraftSpend(phase.annualSpend);
    setDraftStartYear(String(phase.startYear + 1));
    setDraftEndYear(String(phase.endYear));
  };

  const handleEditSave = (id: number) => {
    const idx = phases.findIndex(p => p.id === id);
    let updated = phases.map(p => p.id === id ? { ...p, annualSpend: draftSpend } : p);

    let currentStart = updated[idx].startYear;
    let currentEnd = updated[idx].endYear;

    let targetStart = idx > 0 && !isNaN(parseInt(draftStartYear)) ? parseInt(draftStartYear) - 1 : currentStart;
    let targetEnd = !isNaN(parseInt(draftEndYear)) ? parseInt(draftEndYear) : currentEnd;

    // Prevent phase inversion prior to bounding
    if (targetStart >= targetEnd) {
      targetStart = targetEnd - 1;
    }

    // Clamp to fixed outer bounds
    if (idx > 0) {
      const minStart = updated[idx - 1].startYear + 1;
      targetStart = Math.max(minStart, targetStart);
    }

    if (idx < updated.length - 1) {
      const maxEnd = updated[idx + 1].endYear - 1;
      targetEnd = Math.min(maxEnd, targetEnd);
    } else {
      targetEnd = Math.min(timeHorizon, targetEnd);
    }

    // Secondary phase inversion check (in case outer bounds forced a collision)
    if (targetStart >= targetEnd) {
      targetStart = targetEnd - 1;
    }

    if (idx > 0) {
      updated[idx - 1].endYear = targetStart;
      updated[idx].startYear = targetStart;
    }

    updated[idx].endYear = targetEnd;
    if (idx < updated.length - 1) {
      updated[idx + 1].startYear = targetEnd;
    }

    onChange(updated);
    setEditingId(null);
  };

  const lastPhase = phases[phases.length - 1];
  const canAdd = lastPhase.endYear < timeHorizon || lastPhase.endYear - lastPhase.startYear >= 2;

  return (
    <div>
      {/* Timeline Bar */}
      <div className="flex rounded-full overflow-hidden h-3 mb-1">
        {phases.map((phase, i) => {
          const widthPct = ((phase.endYear - phase.startYear) / timeHorizon) * 100;
          return (
            <div
              key={phase.id}
              style={{ width: `${widthPct}%`, backgroundColor: PHASE_COLORS[i % PHASE_COLORS.length] }}
              className="h-full transition-all duration-300"
              title={`Year ${phase.startYear + 1}–${phase.endYear}: $${phase.annualSpend.toLocaleString()}`}
            />
          );
        })}
      </div>

      {/* Year Markers */}
      <div className="relative h-5 mb-3 text-[10px] text-slate-400 dark:text-slate-500 font-semibold select-none">
        <span className="absolute left-0">0</span>
        {phases.slice(1).map((phase) => {
          const leftPct = (phase.startYear / timeHorizon) * 100;
          return (
            <span
              key={phase.id}
              className="absolute -translate-x-1/2"
              style={{ left: `${leftPct}%` }}
            >
              {phase.startYear}
            </span>
          );
        })}
        <span className="absolute right-0">{timeHorizon}</span>
      </div>

      {/* Phase List */}
      <div className="space-y-2">
        {phases.map((phase, i) => (
          <div
            key={phase.id}
            className={`rounded-lg ${PHASE_BG[i % PHASE_BG.length]}`}
            style={{ borderLeftWidth: '3px', borderLeftColor: PHASE_COLORS[i % PHASE_COLORS.length] }}
          >
            {editingId === phase.id ? (
              /* Inline Edit Form */
              <div className="px-3 py-3 flex flex-col gap-3">
                <div className="flex gap-3 items-start">
                  <div className="flex-1">
                    <label className="block text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
                      Annual Spend
                    </label>
                    <CurrencyInput
                      value={draftSpend}
                      onChange={setDraftSpend}
                      prefix="$"
                      suffix="USD"
                    />
                  </div>
                  <div className="w-24">
                    <label className="block text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
                      Start Year
                    </label>
                    <input
                      type="number"
                      className="w-full bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-3 text-sm font-medium text-slate-800 dark:text-slate-100 focus:ring-1 focus:ring-primary focus:border-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      value={draftStartYear}
                      min={i > 0 ? phases[i - 1].startYear + 2 : 1}
                      max={draftEndYear || phase.endYear}
                      onChange={(e) => setDraftStartYear(e.target.value)}
                      disabled={i === 0}
                    />
                  </div>

                  <div className="w-24">
                    <label className="block text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
                      End Year
                    </label>
                    <input
                      type="number"
                      className="w-full bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-3 text-sm font-medium text-slate-800 dark:text-slate-100 focus:ring-1 focus:ring-primary focus:border-primary transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                      value={draftEndYear}
                      min={draftStartYear || (phase.startYear + 1)}
                      max={i < phases.length - 1 ? phases[i + 1].endYear - 1 : timeHorizon}
                      onChange={(e) => setDraftEndYear(e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleEditSave(phase.id)}
                    className="px-4 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-md text-[11px] font-bold uppercase tracking-wider transition-colors"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    className="px-4 py-1.5 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-300 rounded-md text-[11px] font-bold uppercase tracking-wider transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              /* Display Row */
              <div className="px-3 py-2.5 flex items-center justify-between">
                <span className="text-[13px] font-semibold text-slate-700 dark:text-slate-300">
                  Year {phase.startYear + 1}–{phase.endYear}:{' '}
                  <span className="text-slate-900 dark:text-slate-100">${phase.annualSpend.toLocaleString()}</span>
                  <span className="text-[11px] font-normal text-slate-400 dark:text-slate-500 ml-1">USD/yr</span>
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => openEdit(phase)}
                    className="w-7 h-7 flex items-center justify-center rounded-md bg-white/70 dark:bg-slate-800 hover:bg-white dark:hover:bg-slate-700 transition-colors text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 border border-transparent hover:border-slate-200 dark:hover:border-slate-600"
                    aria-label="Edit phase"
                  >
                    <span className="material-symbols-outlined text-sm" style={{ fontSize: '15px' }}>edit</span>
                  </button>
                  <button
                    onClick={() => handleDelete(phase.id)}
                    disabled={phases.length === 1}
                    className="w-7 h-7 flex items-center justify-center rounded-md bg-white/70 dark:bg-slate-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-slate-400 dark:text-slate-500 hover:text-red-500 border border-transparent hover:border-red-200 dark:hover:border-red-800/40 disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Delete phase"
                  >
                    <span className="material-symbols-outlined text-sm" style={{ fontSize: '15px' }}>close</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add Button */}
      <button
        onClick={handleAdd}
        disabled={!canAdd}
        className="mt-2 w-full border-2 border-dashed border-slate-200 dark:border-slate-700 rounded-lg py-2.5 flex items-center justify-center gap-1.5 text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider hover:border-primary hover:text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span className="material-symbols-outlined text-base" style={{ fontSize: '16px' }}>add</span>
        Add Spending Period
      </button>
    </div>
  );
};

// ─── Sync helper: keep phases contiguous with the current time horizon ────────
function syncPhasesToHorizon(phases: SpendingPhase[], horizon: number): SpendingPhase[] {
  let updated = phases.filter(p => p.startYear < horizon);
  if (updated.length === 0) {
    updated = [{ ...phases[0], startYear: 0, endYear: horizon }];
  } else {
    updated[updated.length - 1] = { ...updated[updated.length - 1], endYear: horizon };
  }
  return updated;
}

// ─── Main SetupView ───────────────────────────────────────────────────────────

const SetupView: React.FC<SetupViewProps> = ({
  defaultInputs,
  onRun,
  isDarkMode,
  onToggleDarkMode
}) => {
  const [formState, setFormState] = useState<SimulationInputs>(defaultInputs);

  useEffect(() => {
    if (JSON.stringify(defaultInputs) !== JSON.stringify(formState)) {
      setFormState(defaultInputs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultInputs]);

  const updateField = (field: keyof SimulationInputs, val: number) => {
    setFormState(prev => ({ ...prev, [field]: val }));
  };

  const handleTimeHorizonChange = (newHorizon: number) => {
    setFormState(prev => ({
      ...prev,
      timeHorizon: newHorizon,
      spendingPhases: syncPhasesToHorizon(prev.spendingPhases, newHorizon),
    }));
  };

  // Input validation
  const getValidationErrors = (): string[] => {
    const errors: string[] = [];

    // --- Individual field sanity checks (prevent engine poisoning) ---
    if (!isFinite(formState.initialCash)) errors.push('Cash savings must be a finite number.');
    if (!isFinite(formState.initialInvestments)) errors.push('Investment portfolio must be a finite number.');
    if (formState.initialCash < 0) errors.push('Cash savings cannot be negative.');
    if (formState.initialInvestments < 0) errors.push('Investment portfolio cannot be negative.');

    const totalPortfolio = formState.initialCash + formState.initialInvestments;
    if (totalPortfolio <= 0) errors.push('Total portfolio must be greater than $0.');
    if (formState.timeHorizon < 5 || formState.timeHorizon > 50) errors.push('Time horizon must be 5–50 years.');

    if (!isFinite(formState.inflationRate) || formState.inflationRate < 0 || formState.inflationRate > 15)
      errors.push('Inflation rate must be 0–15%.');
    if (!isFinite(formState.managementFee) || formState.managementFee < 0 || formState.managementFee > 5)
      errors.push('Management fee must be 0–5%.');

    // --- CPA / Tax field validation ---
    if (formState.currentAge < 25 || formState.currentAge > 85)
      errors.push('Retirement age must be between 25 and 85.');

    // Birth year: plausible range AND consistent with retirement age.
    // Allow ±1 year because the birthday may not have occurred yet this calendar year.
    const thisYear = new Date().getFullYear();
    if (formState.birthYear < 1900 || formState.birthYear > thisYear)
      errors.push('Birth year must be between 1900 and the current year.');
    else if (Math.abs(formState.birthYear - (thisYear - formState.currentAge)) > 1)
      errors.push(`Birth year ${formState.birthYear} does not match retirement age ${formState.currentAge} (expected ~${thisYear - formState.currentAge}).`);

    if (formState.taxDeferredRatio < 0 || formState.taxDeferredRatio > 100)
      errors.push('Tax-deferred ratio must be 0–100%.');
    if (formState.withdrawalTaxRate < 0 || formState.withdrawalTaxRate > 50)
      errors.push('Withdrawal tax rate must be 0–50%.');
    if (formState.socialSecurityAge < 50 || formState.socialSecurityAge > 85)
      errors.push('Social Security / pension claiming age must be between 50 and 85.');

    const phases = formState.spendingPhases;
    if (phases.length === 0) {
      errors.push('At least one spending phase is required.');
    } else {
      if (phases.some(p => p.annualSpend <= 0)) errors.push('All spending phases must have an amount greater than $0.');
      if (phases.some(p => p.annualSpend >= totalPortfolio)) errors.push('Each phase\'s annual spending must be less than total portfolio.');
      if (phases[phases.length - 1].endYear !== formState.timeHorizon) errors.push(`Spending phases must fully cover the Time Horizon (currently ${formState.timeHorizon} Years). Your phases end at Year ${phases[phases.length - 1].endYear}. Please edit or add a phase.`);
    }
    return errors;
  };

  const validationErrors = getValidationErrors();
  const isValid = validationErrors.length === 0;

  const handleRunClick = () => {
    if (!isValid) return;
    onRun(formState);
  };

  return (
    <div className="min-h-screen bg-background-light dark:bg-background-dark animate-fade-in transition-colors duration-300">
      <nav className="border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 transition-colors">
        <div className="max-w-7xl mx-auto px-8 h-20 flex items-center justify-between">
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-primary/20 dark:bg-primary/10 flex items-center justify-center rounded transition-colors">
                <span className="material-symbols-outlined text-primary text-xl">account_balance_wallet</span>
              </div>
              <span className="text-sm font-bold tracking-widest uppercase text-slate-800 dark:text-slate-100">Strategy Lab</span>
            </div>
          </div>
          <div className="flex items-center gap-8">
            <button
              onClick={onToggleDarkMode}
              className="w-10 h-10 bg-slate-50 dark:bg-slate-800 flex items-center justify-center rounded-xl shadow-sm cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors border border-slate-200 dark:border-slate-700"
              aria-label="Toggle theme"
            >
              <span className="material-symbols-outlined text-slate-600 dark:text-slate-400 text-xl">
                {isDarkMode ? 'light_mode' : 'dark_mode'}
              </span>
            </button>
            <a href="#" className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 transition-colors uppercase tracking-wider">Dashboard</a>
            <a href="#" className="text-[11px] font-semibold text-slate-900 dark:text-slate-100 border-b-2 border-primary pb-1 uppercase tracking-wider">Simulation</a>
            <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-center">
              <span className="material-symbols-outlined text-sm dark:text-slate-400">person</span>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-8 py-20">
        <div className="max-w-3xl mx-auto text-center mb-20">
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100 mb-6 transition-colors">Retirement Simulation Setup</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm font-light leading-relaxed transition-colors">
            Configure your financial parameters. Our engine will simultaneously run multiple strategic scenarios—from cash-bucket approaches to bond-heavy allocations—to find your optimal path.
          </p>
        </div>

        <div className="max-w-4xl mx-auto bg-white dark:bg-slate-900 rounded-2xl shadow-[0_32px_64px_-16px_rgba(0,0,0,0.05)] border border-slate-100 dark:border-slate-800 p-12 relative z-10 transition-all">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-10">
            {/* Left Column - Assets */}
            <div className="space-y-8">
              <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider border-b border-slate-100 dark:border-slate-800 pb-2 transition-colors">Assets</h3>
              
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">Birth Year</label>
                <input
                  type="number"
                  min="1900" max="2100"
                  className="w-full bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 text-slate-800 dark:text-slate-100 focus:ring-1 focus:ring-primary focus:border-primary transition-all text-sm font-medium"
                  value={formState.birthYear}
                  onChange={(e) => updateField('birthYear', parseInt(e.target.value) || 0)}
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">Total Cash Savings</label>
                <CurrencyInput
                  value={formState.initialCash}
                  onChange={(v) => updateField('initialCash', v)}
                  prefix="$"
                  suffix="USD"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">Cash, Savings, CDs, and other liquid equivalents.</p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">Investment Portfolio</label>
                <CurrencyInput
                  value={formState.initialInvestments}
                  onChange={(v) => updateField('initialInvestments', v)}
                  prefix="$"
                  suffix="USD"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">Total value of Stocks, Bonds, ETFs, and Mutual Funds.</p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">Social Security / Pension</label>
                <CurrencyInput
                  value={formState.socialSecurityIncome}
                  onChange={(v) => updateField('socialSecurityIncome', v)}
                  prefix="$"
                  suffix="/mo"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">Estimated fixed income to automatically offset withdrawals.</p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">Age to Claim</label>
                <input
                  type="number"
                  min="50" max="80"
                  className="w-full bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 text-slate-800 dark:text-slate-100 focus:ring-1 focus:ring-primary focus:border-primary transition-all text-sm font-medium"
                  value={formState.socialSecurityAge}
                  onChange={(e) => updateField('socialSecurityAge', parseInt(e.target.value) || 0)}
                />
              </div>
            </div>

            {/* Right Column - Variables */}
            <div className="space-y-8">
              <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider border-b border-slate-100 dark:border-slate-800 pb-2 transition-colors">Variables</h3>

              {/* Spending Phases */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3">
                  Spending Phases
                  <span className="ml-2 text-[10px] normal-case font-normal text-slate-400 dark:text-slate-600">
                    (click edit to change amount or duration)
                  </span>
                </label>
                <SpendingPhasesEditor
                  phases={formState.spendingPhases}
                  timeHorizon={formState.timeHorizon}
                  onChange={(phases) => setFormState(prev => ({ ...prev, spendingPhases: phases }))}
                />
              </div>

              {/* Time Horizon */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">Simulation Time Horizon</label>
                <div className="flex items-center gap-4">
                  <input
                    className="w-full h-1 bg-slate-200 dark:bg-slate-700 accent-primary rounded-lg appearance-none cursor-pointer"
                    max="50" min="5"
                    type="range"
                    value={formState.timeHorizon}
                    onChange={(e) => handleTimeHorizonChange(parseInt(e.target.value))}
                  />
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200 w-16 text-right transition-colors">{formState.timeHorizon} Years</span>
                </div>
              </div>

              {/* Inflation & Management Fee */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">Inflation Rate</label>
                <CurrencyInput
                  value={formState.inflationRate}
                  onChange={(v) => updateField('inflationRate', v)}
                  suffix="%"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">Management Fee</label>
                <CurrencyInput
                  value={formState.managementFee}
                  onChange={(v) => updateField('managementFee', v)}
                  suffix="%"
                />
              </div>

              {/* ── CPA / Tax Section ─────────────────────────────────── */}
              <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider border-b border-slate-100 dark:border-slate-800 pb-2 mb-6 transition-colors mt-8">
                Tax &amp; RMD
              </h3>

              {/* Retirement Age */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">
                  Retirement Starting Age
                </label>
                <div className="flex items-center gap-4">
                  <input
                    className="w-full h-1 bg-slate-200 dark:bg-slate-700 accent-primary rounded-lg appearance-none cursor-pointer"
                    min="25" max="85" type="range"
                    value={formState.currentAge}
                    onChange={(e) => updateField('currentAge', parseInt(e.target.value))}
                  />
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200 w-16 text-right transition-colors">{formState.currentAge} yrs</span>
                </div>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">
                  RMDs are enforced automatically from age 73 (IRS Pub. 590-B).
                </p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">
                  Tax-Deferred %
                </label>
                <CurrencyInput
                  value={formState.taxDeferredRatio}
                  onChange={(v) => updateField('taxDeferredRatio', Math.min(100, Math.max(0, v)))}
                  suffix="%"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">
                  Portion subject to RMD triggers.
                </p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">
                  Withdrawal Tax Rate
                </label>
                <CurrencyInput
                  value={formState.withdrawalTaxRate}
                  onChange={(v) => updateField('withdrawalTaxRate', Math.min(50, Math.max(0, v)))}
                  suffix="%"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">
                  Marginal rate on withdrawals.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-16 flex flex-col items-center">
            {validationErrors.length > 0 && (
              <div className="mb-8 max-w-md w-full bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded-lg p-4 transition-colors">
                {validationErrors.map((err, i) => (
                  <p key={i} className="text-xs text-red-600 dark:text-red-400 flex items-center gap-2 mb-1 last:mb-0">
                    <span className="material-symbols-outlined text-sm">warning</span>
                    {err}
                  </p>
                ))}
              </div>
            )}
            <button
              onClick={handleRunClick}
              disabled={!isValid}
              aria-label="Run Monte Carlo simulation"
              className={`group relative px-20 py-5 rounded-lg font-bold text-sm uppercase tracking-wider transition-all shadow-xl shadow-slate-200 dark:shadow-none overflow-hidden ${isValid
                ? 'bg-green-600 text-white hover:bg-green-700 cursor-pointer'
                : 'bg-slate-300 dark:bg-slate-800 text-slate-500 dark:text-slate-600 cursor-not-allowed'
                }`}
            >
              <span className="relative z-10">Run Simulation</span>
              {isValid && <div className="absolute inset-0 bg-primary/10 scale-x-0 group-hover:scale-x-100 transition-transform origin-left"></div>}
            </button>
            <p className="mt-6 text-[11px] font-semibold text-slate-300 dark:text-slate-600 uppercase tracking-wider transition-colors">100,000 Monte Carlo Simulations Per Strategy</p>
          </div>

          <div className="absolute -bottom-4 left-1/2 -translate-x-1/2 flex gap-1">
            <div className="w-1 h-1 rounded-full bg-slate-200 dark:bg-slate-800"></div>
            <div className="w-1 h-1 rounded-full bg-slate-200 dark:bg-slate-800"></div>
            <div className="w-1 h-1 rounded-full bg-slate-200 dark:bg-slate-800"></div>
          </div>
        </div>

        {/* Educational Content Section */}
        <div className="max-w-4xl mx-auto mt-20 pt-10 border-t border-slate-200 dark:border-slate-800 transition-colors">
          <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mb-8 text-center transition-colors">Understanding the Simulation Model</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
            <div className="bg-white dark:bg-slate-900 p-8 rounded-xl border border-slate-100 dark:border-slate-800 shadow-sm transition-all duration-300">
              <div className="w-10 h-10 bg-primary/10 dark:bg-primary/5 rounded-lg flex items-center justify-center mb-4 transition-colors">
                <span className="material-symbols-outlined text-primary">function</span>
              </div>
              <h4 className="text-xs font-bold text-slate-900 dark:text-slate-200 mb-2 transition-colors">What is Monte Carlo?</h4>
              <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed transition-colors">
                Instead of assuming a steady return (e.g., 7% every year), a Monte Carlo simulation uses random sampling to generate thousands of possible market scenarios based on historical volatility. This helps identify the probability of running out of money in "worst-case" scenarios.
              </p>
            </div>
            <div className="bg-white dark:bg-slate-900 p-8 rounded-xl border border-slate-100 dark:border-slate-800 shadow-sm transition-all duration-300">
              <div className="w-10 h-10 bg-primary/10 dark:bg-primary/5 rounded-lg flex items-center justify-center mb-4 transition-colors">
                <span className="material-symbols-outlined text-primary">tune</span>
              </div>
              <h4 className="text-xs font-bold text-slate-900 dark:text-slate-200 mb-2 transition-colors">Why Strategy Matters?</h4>
              <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed transition-colors">
                The allocation between Stocks (growth) and Bonds (stability) determines your portfolio's resilience. The <strong>Bucket Strategy</strong> is unique: it keeps 2 years of cash on hand to avoid selling stocks during market crashes, potentially increasing longevity.
              </p>
            </div>
          </div>
        </div>
      </main>

      <footer className="max-w-7xl mx-auto px-8 py-16 border-t border-slate-50 dark:border-slate-900 mt-20 flex flex-col md:flex-row justify-between items-center gap-6 transition-colors">
        <p className="text-slate-400 dark:text-slate-600 text-[11px] font-semibold uppercase tracking-wider">© {new Date().getFullYear()} Strategy Lab • Private & Confidential Financial Simulation</p>
      </footer>
    </div>
  );
};

export default SetupView;
