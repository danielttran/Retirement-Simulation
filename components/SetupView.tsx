import React, { useState, useEffect } from 'react';
import { SimulationInputs, SpendingPhase } from '../types';

interface SetupViewProps {
  defaultInputs: SimulationInputs;
  onRun: (inputs: SimulationInputs) => void;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
  hasResult?: boolean;
  onShowResult?: () => void;
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
      setDisplayStr((value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 }));
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

    // Clamp to fixed outer bounds derived from adjacent phases
    if (idx > 0) {
      targetStart = Math.max(updated[idx - 1].startYear + 1, targetStart);
    }

    if (idx < updated.length - 1) {
      targetEnd = Math.min(updated[idx + 1].endYear - 1, targetEnd);
    } else {
      targetEnd = Math.min(timeHorizon, targetEnd);
    }

    if (targetStart >= targetEnd) {
      return; // Reject the save operation
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
              title={`Year ${phase.startYear + 1}–${phase.endYear}: $${(phase.annualSpend ?? 0).toLocaleString()}`}
            />
          );
        })}
      </div>

      {/* Year Markers */}
      <div className="relative h-5 mb-3 text-[10px] text-slate-400 dark:text-slate-500 font-semibold select-none">
        <span className="absolute left-0">Yr 1</span>
        {phases.slice(1).map((phase) => {
          const leftPct = (phase.startYear / timeHorizon) * 100;
          return (
            <span
              key={phase.id}
              className="absolute -translate-x-1/2"
              style={{ left: `${leftPct}%` }}
            >
              Yr {phase.startYear + 1}
            </span>
          );
        })}
        <span className="absolute right-0">Yr {timeHorizon}</span>
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
                  <span className="text-slate-900 dark:text-slate-100">${(phase.annualSpend ?? 0).toLocaleString()}</span>
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
  if (!Array.isArray(phases) || phases.length === 0) {
    return [{ id: 1, startYear: 0, endYear: horizon, annualSpend: 30000 }];
  }
  let updated = phases.filter(p => p.startYear < horizon);
  if (updated.length === 0) {
    updated = [{ ...phases[0], startYear: 0, endYear: horizon }];
  } else {
    updated[updated.length - 1] = { ...updated[updated.length - 1], endYear: horizon };
  }
  return updated;
}

// ─── Simple Mode Form ─────────────────────────────────────────────────────────
// A 3-question form for regular people. Maps onto the full SimulationInputs via
// smart defaults — preserves the engine's full accuracy without exposing 20+ knobs.
// Simulation starts AT the user's retirement day, so currentAge = retirementAge
// and birthYear is back-calculated to keep RMD-age math consistent.

interface SimpleFormProps {
  defaultInputs: SimulationInputs;
  onRun: (inputs: SimulationInputs) => void;
  onSwitchToAdvanced: () => void;
  hasResult?: boolean;
  isChanged: boolean;
  onShowResult?: () => void;
}

const SimpleSetupForm: React.FC<SimpleFormProps> = ({ defaultInputs, onRun, onSwitchToAdvanced, hasResult, isChanged, onShowResult }) => {
  // Derive simple-mode initial values from existing inputs so toggling Advanced ↔
  // Simple round-trips reasonably. Spending = sum of phase 1 amount / 12.
  const init = defaultInputs;
  const [retirementAge, setRetirementAge] = useState<number>(Math.max(40, init.currentAge));
  const [savings, setSavings] = useState<number>(init.initialCash + init.initialInvestments);
  const [monthlySpend, setMonthlySpend] = useState<number>(
    Math.round(((init.spendingPhases[0]?.annualSpend) || 60000) / 12)
  );
  const [ssMonthly, setSsMonthly] = useState<number>(init.socialSecurityIncome || 1900);
  const [ssAge, setSsAge] = useState<number>(init.socialSecurityAge);
  const [useSEPP, setUseSEPP] = useState<boolean>(init.useSEPP || retirementAge < 59);
  const [includeHealthcare, setIncludeHealthcare] = useState<boolean>(init.includeHealthcare ?? true);

  const isEarly = retirementAge < 59.5;
  const horizon = Math.max(5, Math.min(50, 95 - retirementAge));

  // Smart default Trad/Roth split: older retirees skew more Traditional (401(k)
  // history), younger ones tilt slightly more Roth as those vehicles only matured
  // in the last ~25 years. These are coarse but realistic for regular-person mode.
  const taxDeferredRatio = retirementAge >= 60 ? 80 : 70;
  const rothRatio = retirementAge >= 60 ? 10 : 15;

  const handleRun = () => {
    const annual = monthlySpend * 12;
    // 95 % stocks-only-risk allocation default for fixed-mix strategies in Simple Mode
    // is unnecessary because BUCKET is the default selected strategy and uses its own
    // sizing logic. Use safe centrist values for the other knobs.
    const merged: SimulationInputs = {
      ...defaultInputs,
      currentAge: retirementAge,
      birthYear: new Date().getFullYear() - retirementAge,
      timeHorizon: horizon,
      // Single phase covering full horizon. Cash split 10% / Investments 90%.
      initialCash: Math.round(savings * 0.10),
      initialInvestments: Math.round(savings * 0.90),
      spendingPhases: [{ id: 1, startYear: 0, endYear: horizon, annualSpend: annual }],
      socialSecurityIncome: ssMonthly,
      socialSecurityAge: ssAge,
      taxDeferredRatio,
      rothRatio,
      withdrawalTaxRate: 22,
      inflationRate: 3.0,
      expectedStockReturn: 8.5,
      expectedBondReturn: 4.0,
      expectedCashReturn: 2.5,
      expectedStockVolatility: 17.0,
      managementFee: 0.10,
      percentileAverage: 50,
      percentileBelowAverage: 25,
      percentileDownturn: 10,
      useSEPP: isEarly && useSEPP,
      seppRate: 5.0,
      includeHealthcare,
    };
    if (hasResult && !isChanged && onShowResult) {
      onShowResult();
    } else {
      onRun(merged);
    }
  };

  const valid = savings > 0 && monthlySpend > 0 && retirementAge >= 25 && retirementAge <= 85;

  return (
    <div className="max-w-2xl mx-auto bg-white dark:bg-slate-900 rounded-2xl shadow-[0_32px_64px_-16px_rgba(0,0,0,0.05)] border border-slate-100 dark:border-slate-800 p-12 transition-all">
      <div className="flex items-center justify-between mb-10">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Quick Plan</h2>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">Three questions. We handle the rest.</p>
        </div>
        <button
          onClick={onSwitchToAdvanced}
          className="text-[10px] font-bold uppercase tracking-wider text-primary hover:text-primary/80 transition-colors"
        >
          Switch to Advanced →
        </button>
      </div>

      {/* Step 1 — About You */}
      <section className="mb-10">
        <h3 className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-4">1. When will you retire?</h3>
        <div className="bg-slate-50 dark:bg-slate-800/40 rounded-xl p-5">
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-3">Retirement age</label>
          <div className="flex items-center gap-4">
            <input type="range" min={40} max={75} value={retirementAge}
              onChange={(e) => setRetirementAge(parseInt(e.target.value))}
              className="w-full h-1 bg-slate-200 dark:bg-slate-700 accent-primary rounded-lg cursor-pointer" />
            <span className="text-xl font-bold text-slate-900 dark:text-slate-100 w-12 text-right">{retirementAge}</span>
          </div>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-3 leading-relaxed">
            Simulation starts on your retirement day and runs to age 95 ({horizon}-year horizon).
            {isEarly && <span className="text-amber-600 dark:text-amber-400 font-medium"> ⚠ Retiring before 59½ — see SEPP option below.</span>}
          </p>
        </div>
      </section>

      {/* Step 2 — Your Money */}
      <section className="mb-10">
        <h3 className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-4">2. The money</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-slate-50 dark:bg-slate-800/40 rounded-xl p-5">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-3">
              Total savings at retirement
            </label>
            <CurrencyInput value={savings} onChange={setSavings} prefix="$" suffix="USD" />
            <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 leading-relaxed">
              All accounts combined: 401(k), IRA, Roth, brokerage, savings. We auto-split {taxDeferredRatio}% Traditional / {rothRatio}% Roth / {100 - taxDeferredRatio - rothRatio}% taxable.
            </p>
          </div>
          <div className="bg-slate-50 dark:bg-slate-800/40 rounded-xl p-5">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-3">
              Monthly spending in retirement
            </label>
            <CurrencyInput value={monthlySpend} onChange={setMonthlySpend} prefix="$" suffix="/mo" />
            <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 leading-relaxed">
              Today's dollars. We adjust for inflation automatically. ${(monthlySpend * 12).toLocaleString()}/yr.
            </p>
          </div>
        </div>
      </section>

      {/* Step 3 — Social Security */}
      <section className="mb-10">
        <h3 className="text-[11px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-4">3. Social Security</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-slate-50 dark:bg-slate-800/40 rounded-xl p-5">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-3">Expected monthly benefit</label>
            <CurrencyInput value={ssMonthly} onChange={setSsMonthly} prefix="$" suffix="/mo" />
            <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2">
              U.S. average ≈ $1,900/mo. Check ssa.gov for your estimate, or just use the default.
            </p>
          </div>
          <div className="bg-slate-50 dark:bg-slate-800/40 rounded-xl p-5">
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-3">Claiming age</label>
            <div className="flex items-center gap-4">
              <input type="range" min={62} max={70} value={ssAge}
                onChange={(e) => setSsAge(parseInt(e.target.value))}
                className="w-full h-1 bg-slate-200 dark:bg-slate-700 accent-primary rounded-lg cursor-pointer" />
              <span className="text-xl font-bold text-slate-900 dark:text-slate-100 w-10 text-right">{ssAge}</span>
            </div>
            <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2">
              Each year you delay past 67 adds ~8% to your monthly check (up to age 70).
            </p>
          </div>
        </div>
      </section>

      {/* Optional toggles */}
      <section className="mb-10 space-y-3">
        {isEarly && (
          <label className="flex items-start gap-3 p-4 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900/40 rounded-xl cursor-pointer hover:bg-amber-100/50 dark:hover:bg-amber-900/20 transition-colors">
            <input type="checkbox" checked={useSEPP} onChange={(e) => setUseSEPP(e.target.checked)}
              className="mt-1 accent-amber-600" />
            <div className="flex-1">
              <p className="text-sm font-bold text-slate-900 dark:text-slate-100">
                Set up SEPP (Rule 72(t)) — avoid 10% early-withdrawal penalty
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                Lets you tap your 401(k)/IRA/Roth before 59½ penalty-free using IRS-approved Substantially Equal Periodic Payments.
                Locked in until 59½. Withdrawals above the SEPP cap still incur the 10% penalty.
              </p>
            </div>
          </label>
        )}
        <label className="flex items-start gap-3 p-4 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 rounded-xl cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-800/70 transition-colors">
          <input type="checkbox" checked={includeHealthcare} onChange={(e) => setIncludeHealthcare(e.target.checked)}
            className="mt-1 accent-primary" />
          <div className="flex-1">
            <p className="text-sm font-bold text-slate-900 dark:text-slate-100">
              Include realistic healthcare costs
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
              Adds ~$8,000/yr before age 65 (private insurance / ACA bridge) and ~$7,000/yr after (Medicare + supplemental).
              Inflated at medical CPI (~5.5%/yr). The #1 expense regular people forget.
            </p>
          </div>
        </label>
      </section>

      <div className="flex flex-col items-center">
        <button
          onClick={handleRun}
          disabled={!valid}
          className={`w-full sm:w-auto px-20 py-5 rounded-lg font-bold text-sm uppercase tracking-wider transition-all shadow-xl ${valid
            ? 'bg-green-600 text-white hover:bg-green-700 cursor-pointer'
            : 'bg-slate-300 dark:bg-slate-800 text-slate-500 dark:text-slate-600 cursor-not-allowed'}`}
        >
          {hasResult && !isChanged ? 'Show Result' : 'Run Simulation'}
        </button>
        <p className="mt-5 text-[10px] font-semibold text-slate-300 dark:text-slate-600 uppercase tracking-wider">
          Tested across 100,000 possible market futures
        </p>
      </div>
    </div>
  );
};

// ─── Main SetupView ───────────────────────────────────────────────────────────

const SetupView: React.FC<SetupViewProps> = ({
  defaultInputs,
  onRun,
  isDarkMode,
  onToggleDarkMode,
  hasResult,
  onShowResult
}) => {
  const [mode, setMode] = useState<'simple' | 'advanced'>(() => {
    const saved = localStorage.getItem('setupMode');
    return saved === 'advanced' ? 'advanced' : 'simple';
  });
  useEffect(() => { localStorage.setItem('setupMode', mode); }, [mode]);

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
    if (!isFinite(formState.expectedStockReturn) || formState.expectedStockReturn < 0 || formState.expectedStockReturn > 30)
      errors.push('Expected stock return must be 0–30%.');
    if (!isFinite(formState.expectedBondReturn) || formState.expectedBondReturn < 0 || formState.expectedBondReturn > 20)
      errors.push('Expected bond return must be 0–20%.');
    if (!isFinite(formState.expectedCashReturn) || formState.expectedCashReturn < 0 || formState.expectedCashReturn > 15)
      errors.push('Expected cash return must be 0–15%.');
    if (!isFinite(formState.expectedStockVolatility) || formState.expectedStockVolatility < 1 || formState.expectedStockVolatility > 60)
      errors.push('Stock volatility must be 1–60%.');
    if (!isFinite(formState.managementFee) || formState.managementFee < 0 || formState.managementFee > 5)
      errors.push('Management fee must be 0–5%.');
    if (!isFinite(formState.customStockAllocation) || formState.customStockAllocation < 0 || formState.customStockAllocation > 100)
      errors.push('Custom stock allocation must be 0–100%.');
    if (!isFinite(formState.customCashAllocation) || formState.customCashAllocation < 0 || formState.customCashAllocation > 100)
      errors.push('Custom cash allocation must be 0–100%.');
    if (formState.customStockAllocation + formState.customCashAllocation > 100)
      errors.push('Custom stock + cash allocation must be 100% or less.');

    // --- CPA / Tax field validation ---
    if (formState.currentAge < 25 || formState.currentAge > 85)
      errors.push('Retirement age must be between 25 and 85.');

    // Birth year: plausible range only. Birth year and retirement age are independent
    // inputs — birth year drives the RMD schedule while retirement age is when the
    // user plans to stop working (potentially far in the future).
    const thisYear = new Date().getFullYear();
    if (formState.birthYear < 1900 || formState.birthYear > thisYear)
      errors.push('Birth year must be between 1900 and the current year.');

    if (formState.taxDeferredRatio < 0 || formState.taxDeferredRatio > 100)
      errors.push('Tax-deferred ratio must be 0–100%.');
    if (formState.rothRatio < 0 || formState.rothRatio > 100)
      errors.push('Roth ratio must be 0–100%.');
    if (formState.taxDeferredRatio + formState.rothRatio > 100)
      errors.push('Tax-deferred + Roth ratio must total ≤ 100% (remainder is taxable brokerage).');
    if (!isFinite(formState.seppRate) || formState.seppRate < 0 || formState.seppRate > 12)
      errors.push('SEPP rate must be 0–12%.');
    if (formState.withdrawalTaxRate < 0 || formState.withdrawalTaxRate > 60)
      errors.push('Withdrawal tax rate must be 0–60%.');
    if (formState.socialSecurityAge < 50 || formState.socialSecurityAge > 85)
      errors.push('Social Security / pension claiming age must be between 50 and 85.');

    // Scenario band percentiles
    if (formState.percentileDownturn >= formState.percentileBelowAverage)
      errors.push('Downturn percentile must be lower than Below Average percentile.');
    if (formState.percentileBelowAverage >= formState.percentileAverage)
      errors.push('Below Average percentile must be lower than Average percentile.');

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
  
  const isChanged = JSON.stringify(defaultInputs) !== JSON.stringify(formState);

  const handleRunClick = () => {
    if (!isValid) return;
    if (hasResult && !isChanged && onShowResult) {
      onShowResult();
    } else {
      onRun(formState);
    }
  };

  // Shared chrome (header + dark-mode toggle) wraps either form variant.
  const chromeHeader = (
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
        </div>
      </div>
    </nav>
  );

  if (mode === 'simple') {
    return (
      <div className="min-h-screen bg-background-light dark:bg-background-dark animate-fade-in transition-colors duration-300">
        {chromeHeader}
        <main className="max-w-7xl mx-auto px-8 py-16">
          <div className="max-w-2xl mx-auto text-center mb-12">
            <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100 mb-4">Will my retirement plan work?</h1>
            <p className="text-slate-500 dark:text-slate-400 text-sm font-light leading-relaxed">
              Answer three quick questions and we'll test your plan against 100,000 possible market futures — including crashes, inflation, taxes, and IRS rules.
            </p>
          </div>
          <SimpleSetupForm
            defaultInputs={defaultInputs}
            onRun={onRun}
            onSwitchToAdvanced={() => setMode('advanced')}
            hasResult={hasResult}
            isChanged={isChanged}
            onShowResult={onShowResult}
          />
        </main>
      </div>
    );
  }

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
            <button
              onClick={() => setMode('simple')}
              className="ml-4 text-[10px] font-bold uppercase tracking-wider text-primary hover:text-primary/80 transition-colors"
            >
              ← Back to Simple
            </button>
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
            Enter your numbers below. The engine runs <strong>100,000 randomized market scenarios</strong> across four withdrawal strategies — Bucket, 60/40, 70/30, and Custom — so you can compare how each holds up in every possible future.
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
                  min="1900" max={new Date().getFullYear()}
                  className="w-full bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 text-slate-800 dark:text-slate-100 focus:ring-1 focus:ring-primary focus:border-primary transition-all text-sm font-medium"
                  value={formState.birthYear}
                  onChange={(e) => updateField('birthYear', parseInt(e.target.value) || 0)}
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">Used to calculate your age each year and to determine when IRS Required Minimum Distributions (RMDs) begin — age 72 (born &le;1950), 73 (born 1951–1959), or 75 (born &ge;1960) under SECURE 2.0.</p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">Total Cash Savings</label>
                <CurrencyInput
                  value={formState.initialCash}
                  onChange={(v) => updateField('initialCash', v)}
                  prefix="$"
                  suffix="USD"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">Money-market accounts, savings accounts, CDs, and any cash you plan to have liquid at retirement. Held outside the market — protects you from being forced to sell investments at a loss early in retirement.</p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">Investment Portfolio</label>
                <CurrencyInput
                  value={formState.initialInvestments}
                  onChange={(v) => updateField('initialInvestments', v)}
                  prefix="$"
                  suffix="USD"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">Combined value of all market-invested assets: 401(k), IRA, brokerage accounts, ETFs, and mutual funds. This is the portion of your savings exposed to market risk and long-term growth.</p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">Social Security / Pension</label>
                <CurrencyInput
                  value={formState.socialSecurityIncome}
                  onChange={(v) => updateField('socialSecurityIncome', v)}
                  prefix="$"
                  suffix="/mo"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">Your estimated monthly benefit. Once you reach your claiming age, this amount reduces how much the simulation needs to withdraw from your portfolio each year — protecting your investments from being spent too fast. (Note: Assumes up to 85% of this benefit may be taxable based on IRS rules, reducing the net offset).</p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2">Age to Claim</label>
                <input
                  type="number"
                  min="50" max="85"
                  className="w-full bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 text-slate-800 dark:text-slate-100 focus:ring-1 focus:ring-primary focus:border-primary transition-all text-sm font-medium"
                  value={formState.socialSecurityAge}
                  onChange={(e) => updateField('socialSecurityAge', parseInt(e.target.value) || 0)}
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">The age at which your monthly benefit begins. Social Security: age 62 (reduced) to 70 (maximum). Pensions or annuities may start earlier (age 50+). Delaying Social Security past your Full Retirement Age adds roughly 8% per year to your monthly check.</p>
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
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">How many years the simulation runs. A 30-year horizon covers retirement from age 65 to 95. Longer horizons stress-test your plan through more market cycles.</p>
              </div>

              {/* Inflation & Management Fee */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">Inflation Rate</label>
                <CurrencyInput
                  value={formState.inflationRate}
                  onChange={(v) => updateField('inflationRate', v)}
                  suffix="%"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">How fast prices rise each year on average. The simulation randomly varies inflation year-to-year around this figure (&#xb1;1.5% standard deviation). Long-run U.S. average: ~3%.</p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">Expected Yearly Stock Return</label>
                <CurrencyInput
                  value={formState.expectedStockReturn}
                  onChange={(v) => updateField('expectedStockReturn', v)}
                  suffix="%"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">The expected average annual return from your stock investments, before subtracting inflation (nominal return). The simulation adds realistic randomness — some years will be far above or below this target. Historical S&P 500 nominal average: ~10%.</p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">Stock Return Volatility (Std Dev)</label>
                <CurrencyInput
                  value={formState.expectedStockVolatility}
                  onChange={(v) => updateField('expectedStockVolatility', v)}
                  suffix="%"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">How much stock returns vary year-to-year around the expected mean. Higher = wilder swings, more crash risk, but also more upside. Historical S&amp;P 500 annualized volatility: ~17%. A globally diversified portfolio might use 14–15%; a concentrated growth portfolio 20–25%.</p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">Expected Yearly Bond Return</label>
                <CurrencyInput
                  value={formState.expectedBondReturn}
                  onChange={(v) => updateField('expectedBondReturn', v)}
                  suffix="%"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">Expected average annual return on bond holdings before inflation (nominal). Reflects long-term yields on investment-grade bonds. Use current 10-year Treasury yield as a forward-looking guide. Historical average: ~4%.</p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">Expected Yearly Cash / HYSA Return</label>
                <CurrencyInput
                  value={formState.expectedCashReturn}
                  onChange={(v) => updateField('expectedCashReturn', v)}
                  suffix="%"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">Expected average annual return on money-market / HYSA holdings before inflation. Tracks short-term interest rates. Use current fed funds rate or HYSA rate as a guide. Historical average: ~2.5%.</p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">Management Fee</label>
                <CurrencyInput
                  value={formState.managementFee}
                  onChange={(v) => updateField('managementFee', v)}
                  suffix="%"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">Annual percentage fee on all assets under management (stocks, bonds, and cash). Represents an RIA advisory fee or blended expense ratio charged on total AUM. Common range: 0.05% for index ETFs to 1.0% for actively managed accounts.</p>
              </div>

              {/* ── CPA / Tax Section ─────────────────────────────────── */}
              <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider border-b border-slate-100 dark:border-slate-800 pb-2 mb-6 transition-colors mt-8">
                Tax &amp; Required Minimum Distributions (RMD)
              </h3>

              {/* Retirement Age */}
              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">
                  Your Current Age (Simulation Starts Now)
                </label>
                <div className="flex items-center gap-4">
                  <input
                    className="w-full h-1 bg-slate-200 dark:bg-slate-700 accent-primary rounded-lg appearance-none cursor-pointer"
                    min="25" max="85" type="range"
                    value={formState.currentAge}
                    onChange={(e) => {
                      const newAge = parseInt(e.target.value);
                      setFormState(prev => ({
                        ...prev,
                        currentAge: newAge
                      }));
                    }}
                  />
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200 w-16 text-right transition-colors">{formState.currentAge} yrs</span>
                </div>
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">
                  Your current age. The simulation projects forward from today. RMDs begin at age 72 (born &le;1950), 73 (born 1951&ndash;1959), or 75 (born &ge;1960) per SECURE 2.0 / IRS Pub. 590-B &mdash; calculated automatically from your Birth Year.
                </p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">
                  % Held in Pre-Tax Accounts (Traditional IRA / 401k)
                </label>
                <CurrencyInput
                  value={formState.taxDeferredRatio}
                  onChange={(v) => updateField('taxDeferredRatio', Math.min(100, Math.max(0, v)))}
                  suffix="%"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">
                  What share of your portfolio sits in tax-deferred accounts (Traditional IRA, 401(k), 403(b)). Withdrawals from these accounts are taxed as ordinary income &mdash; the simulation grosses up your spending to cover the tax bill. The rest (Roth IRA, taxable brokerage) is treated as already-taxed.
                </p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">
                  Effective Tax Rate on Pre-Tax Withdrawals
                </label>
                <CurrencyInput
                  value={formState.withdrawalTaxRate}
                  onChange={(v) => updateField('withdrawalTaxRate', Math.min(60, Math.max(0, v)))}
                  suffix="%"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">
                  Your expected income tax rate on pre-tax account withdrawals. Only the pre-tax portion (set above) is taxed &mdash; e.g., if 60% is in a Traditional IRA and your rate is 22%, the blended drag is 13.2% of all withdrawals. Typical range: 10&ndash;32%. Maximum allowed: 60% (extreme edge case for large distributions).
                </p>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">
                  % Held in Roth Accounts (Roth IRA / Roth 401k)
                </label>
                <CurrencyInput
                  value={formState.rothRatio}
                  onChange={(v) => updateField('rothRatio', Math.min(100 - formState.taxDeferredRatio, Math.max(0, v)))}
                  suffix="%"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">
                  Already-taxed retirement assets. Withdrawals are tax-free. Combined with Pre-Tax must be &le; 100%; remainder is treated as taxable brokerage. SEPP / Rule 72(t) applies to <em>both</em> Traditional and Roth balances combined.
                </p>
              </div>

              {/* ── Early Retirement & Healthcare ─────────────────────── */}
              <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider border-b border-slate-100 dark:border-slate-800 pb-2 mb-6 transition-colors mt-8">
                Early Retirement &amp; Healthcare
              </h3>

              <label className="flex items-start gap-3 p-4 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900/40 rounded-xl cursor-pointer">
                <input
                  type="checkbox"
                  checked={formState.useSEPP}
                  onChange={(e) => setFormState(prev => ({ ...prev, useSEPP: e.target.checked }))}
                  className="mt-1 accent-amber-600"
                />
                <div className="flex-1">
                  <p className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    Enable SEPP / Rule 72(t)
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                    Penalty-free withdrawals from retirement accounts before age 59½ via the Fixed-Amortization method. Required if you retire early and need to draw from your 401(k)/IRA/Roth. Withdrawals above the SEPP cap incur the 10% federal early-withdrawal penalty.
                  </p>
                </div>
              </label>

              <div>
                <label className="block text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 transition-colors">
                  SEPP Interest Rate (Fixed Amortization)
                </label>
                <CurrencyInput
                  value={formState.seppRate}
                  onChange={(v) => updateField('seppRate', Math.min(12, Math.max(0, v)))}
                  suffix="%"
                />
                <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2 transition-colors">
                  IRS caps this at 120% of the federal mid-term Applicable Federal Rate (AFR). ~5.0% is a current proxy. Higher rate ⇒ larger annual SEPP cap.
                </p>
              </div>

              <label className="flex items-start gap-3 p-4 bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 rounded-xl cursor-pointer">
                <input
                  type="checkbox"
                  checked={formState.includeHealthcare}
                  onChange={(e) => setFormState(prev => ({ ...prev, includeHealthcare: e.target.checked }))}
                  className="mt-1 accent-primary"
                />
                <div className="flex-1">
                  <p className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    Include Realistic Healthcare Costs
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                    Adds ~$8,000/yr before age 65 (private insurance / ACA bridge) and ~$7,000/yr after 65 (Medicare Part B+D + supplemental + OOP), inflated at medical CPI (~2.5% above general CPI). The largest expense category most retirees underestimate.
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* ── Scenario Bands ─────────────────────────────────── */}
          <div className="max-w-2xl mx-auto mt-10 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-xl p-8 shadow-sm transition-colors duration-300">
            <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100 uppercase tracking-wider border-b border-slate-100 dark:border-slate-800 pb-2 mb-6 transition-colors">
              Scenario Bands
            </h3>
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mb-6 leading-relaxed transition-colors">
              Each scenario line on the chart represents a percentile of the 100,000 Monte Carlo runs. Adjust these to stress-test different market environments — e.g. set Downturn to 5 for a worst-5% scenario.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <label className="block text-[11px] font-semibold text-growth-green dark:text-green-400 uppercase tracking-wider mb-2 transition-colors">
                  Average Market (Percentile)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    className="w-full h-1 bg-slate-200 dark:bg-slate-700 accent-primary rounded-lg appearance-none cursor-pointer"
                    min="1" max="99" type="range"
                    value={formState.percentileAverage}
                    onChange={(e) => updateField('percentileAverage', parseInt(e.target.value))}
                  />
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200 w-10 text-right transition-colors">P{formState.percentileAverage}</span>
                </div>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1.5 transition-colors">Green line: {formState.percentileAverage}% of runs ended below this line &mdash; {100 - formState.percentileAverage}% ended above. At P50 this is the median: the most likely single outcome for planning.</p>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-below-avg-gold dark:text-amber-400 uppercase tracking-wider mb-2 transition-colors">
                  Below Average (Percentile)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    className="w-full h-1 bg-slate-200 dark:bg-slate-700 accent-primary rounded-lg appearance-none cursor-pointer"
                    min="1" max="99" type="range"
                    value={formState.percentileBelowAverage}
                    onChange={(e) => updateField('percentileBelowAverage', parseInt(e.target.value))}
                  />
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200 w-10 text-right transition-colors">P{formState.percentileBelowAverage}</span>
                </div>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1.5 transition-colors">Gold line: {formState.percentileBelowAverage}% of runs ended below this line. Shows a persistently sluggish market &mdash; good for conservative planning.</p>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-downturn-red dark:text-red-400 uppercase tracking-wider mb-2 transition-colors">
                  Downturn (Percentile)
                </label>
                <div className="flex items-center gap-3">
                  <input
                    className="w-full h-1 bg-slate-200 dark:bg-slate-700 accent-primary rounded-lg appearance-none cursor-pointer"
                    min="1" max="99" type="range"
                    value={formState.percentileDownturn}
                    onChange={(e) => updateField('percentileDownturn', parseInt(e.target.value))}
                  />
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-200 w-10 text-right transition-colors">P{formState.percentileDownturn}</span>
                </div>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-1.5 transition-colors">Red line: Only {formState.percentileDownturn}% of runs ended lower than this &mdash; {100 - formState.percentileDownturn}% survived better. If this line stays above $0, your plan is extremely resilient.</p>
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
              aria-label={hasResult && !isChanged ? "Show Result" : "Run Monte Carlo simulation"}
              className={`group relative px-20 py-5 rounded-lg font-bold text-sm uppercase tracking-wider transition-all shadow-xl shadow-slate-200 dark:shadow-none overflow-hidden ${isValid
                ? 'bg-green-600 text-white hover:bg-green-700 cursor-pointer'
                : 'bg-slate-300 dark:bg-slate-800 text-slate-500 dark:text-slate-600 cursor-not-allowed'
                }`}
            >
              <span className="relative z-10">{hasResult && !isChanged ? "Show Result" : "Run Simulation"}</span>
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
                Instead of assuming a steady return every year, a Monte Carlo simulation runs your plan through 100,000 randomly generated future market paths &mdash; calibrated to long-term historical averages, but not tied to any specific historical sequence. This reveals the true probability of running out of money, not just a single optimistic estimate.
              </p>
            </div>
            <div className="bg-white dark:bg-slate-900 p-8 rounded-xl border border-slate-100 dark:border-slate-800 shadow-sm transition-all duration-300">
              <div className="w-10 h-10 bg-primary/10 dark:bg-primary/5 rounded-lg flex items-center justify-center mb-4 transition-colors">
                <span className="material-symbols-outlined text-primary">tune</span>
              </div>
              <h4 className="text-xs font-bold text-slate-900 dark:text-slate-200 mb-2 transition-colors">Why Strategy Matters?</h4>
              <p className="text-sm text-slate-500 dark:text-slate-400 leading-relaxed transition-colors">
                Your mix of Stocks (growth) and Bonds/Cash (stability) determines how your savings weather bad times. The <strong>Bucket Strategy</strong> is unique: it keeps 2 years of living expenses in cash to avoid selling stocks during market crashes, giving your investments time to recover.
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
