import React, { useState, useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid } from 'recharts';
import { SimulationInputs, SimulationResult, StrategyType, AuditRow } from '../types';

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    name: string;
    value: number | string;
    color: string;
    payload?: any;
    dataKey?: string | number;
  }>;
  label?: string | number;
  startYear: number;
}

// Typed tooltip props
const CustomTooltip = ({ active, payload, label, startYear }: CustomTooltipProps) => {
  if (active && payload && payload.length) {
    const yearNum = typeof label === 'number' ? label : parseInt(String(label));
    const yearsAway = yearNum - startYear;

    return (
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 rounded-xl shadow-xl min-w-[200px]">
        <div className="border-b border-slate-100 dark:border-slate-800 pb-2 mb-2">
          <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest">Forecast Year</p>
          <p className="text-sm font-bold text-slate-800 dark:text-slate-100">
            {label}
            {yearsAway > 0 && <span className="text-[10px] text-slate-400 dark:text-slate-500 font-normal ml-1">({yearsAway} years away)</span>}
          </p>
        </div>
        <div className="space-y-1">
          {payload.map((entry, index) => (
            <div key={index} className="flex justify-between items-center gap-4">
              <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: entry.color }}>
                {entry.name}
              </span>
              <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                {entry.value !== null && typeof entry.value === 'number'
                  ? `$${entry.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                  : 'Depleted'}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return null;
};

interface SimulationViewProps {
  inputs: SimulationInputs;
  results: SimulationResult;
  selectedStrategy: StrategyType;
  setSelectedStrategy: (s: StrategyType) => void;
  onEdit: () => void;
  onRun: () => void;
  onCustomAllocationChange: (alloc: number) => void;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
}

const SimulationView: React.FC<SimulationViewProps> = ({
  inputs,
  results,
  selectedStrategy,
  setSelectedStrategy,
  onEdit,
  onRun,
  onCustomAllocationChange,
  isDarkMode,
  onToggleDarkMode
}) => {
  const [viewDuration, setViewDuration] = useState<number | 'MAX'>('MAX');
  const [auditMode, setAuditMode] = useState(false);
  const [auditScenario, setAuditScenario] = useState<'AVERAGE' | 'BELOW' | 'DOWNTURN'>('BELOW');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Use the year stamped on the simulation data rather than the current clock so
  // that chart x-axis, audit row year labels, and "X years away" offsets are all
  // consistent even if the component renders after a calendar-year boundary.
  const startYear = results.data.length > 0 ? results.data[0].year : new Date().getFullYear();

  const aiPromptText = useMemo(() => {
    const auditRows = results.auditLogAverage;
    const auditSample = auditRows.slice(0, 10).map(r =>
      `  Yr ${r.year} | Age ${inputs.currentAge + (r.year - startYear)} | Start $${Math.round((r.startCash ?? 0) + (r.startStock ?? 0) + (r.startBond ?? 0)).toLocaleString()} | Stock ${((r.stockReturn ?? 0) * 100).toFixed(1)}% Bond ${((r.bondReturn ?? 0) * 100).toFixed(1)}% Infl ${((r.realizedInflation ?? 0) * 100).toFixed(1)}% | Growth ${r.growthAmount >= 0 ? '+' : ''}$${Math.round(r.growthAmount ?? 0).toLocaleString()} | Fees -$${Math.round(r.feesAmount ?? 0).toLocaleString()} | Withdrawal -$${Math.round(r.withdrawal ?? 0).toLocaleString()} (Tax -$${Math.round(r.taxPaid ?? 0).toLocaleString()}) | SS +$${Math.round(r.ssIncome ?? 0).toLocaleString()} | RMD floor $${Math.round(r.rmdAmount ?? 0).toLocaleString()} | End $${Math.round(r.endTotal ?? 0).toLocaleString()}${r.crashed ? ' [CRASH EVENT]' : ''}${r.gkEvent ? ` [GK: ${r.gkEvent}]` : ''}`
    ).join('\n');

    return `Retirement Simulation Validation Request
Please evaluate the mathematical correctness, IRS compliance, and financial risk of the following retirement plan.

--- INPUTS ---
Portfolio: $${((inputs.initialCash ?? 0) + (inputs.initialInvestments ?? 0)).toLocaleString()} (Cash: $${(inputs.initialCash ?? 0).toLocaleString()}, Investments: $${(inputs.initialInvestments ?? 0).toLocaleString()})
Start Year: ${startYear}  |  Time Horizon: ${inputs.timeHorizon} years
Inflation Rate (mean): ${inputs.inflationRate}%
Management Fee: ${inputs.managementFee}%
Retirement Age: ${inputs.currentAge} years  |  Birth Year: ${inputs.birthYear}
Tax-Deferred Ratio: ${inputs.taxDeferredRatio}%  |  Withdrawal Tax Rate: ${inputs.withdrawalTaxRate}%
Social Security: $${(inputs.socialSecurityIncome ?? 0).toLocaleString()}/mo starting at age ${inputs.socialSecurityAge}

--- SPENDING PHASES ---
${inputs.spendingPhases.map(p => `  Year ${p.startYear + 1}–${p.endYear}: $${(p.annualSpend ?? 0).toLocaleString()}/yr (in today's dollars)`).join('\n')}

--- STRATEGY ---
Selected Strategy: ${getStrategyLabel(selectedStrategy)}
Target Allocation: ${(results.allocation.stock * 100).toFixed(1)}% Stock / ${(results.allocation.bond * 100).toFixed(1)}% Bond / ${(results.allocation.cash * 100).toFixed(1)}% Cash

--- SIMULATION MODEL (for your reference) ---
Engine: 100,000-path Monte Carlo, log-normal returns, Cholesky correlation (Stock–Bond ρ=−0.15)
Market Assumptions: Stock μ=${inputs.expectedStockReturn}%/σ=17%, Bond μ=4.0%/σ=5%, Cash μ=2.5%/σ=1.5% (all nominal)
Transaction Cost: 0.05% friction applied to all sell/buy/rebalance trades (in addition to the annual management fee)
Stochastic Inflation: N(${inputs.inflationRate}%, 1.5%²) drawn per year; correlated −0.30 with equity draw
Jump Diffusion (Merton): 2% annual probability of an extra 20–40% equity drawdown beyond log-normal
Guyton-Klinger Guardrails:
  • Safety Rule: If CWR > 120% of IWR AND the prior year's total portfolio return was negative → spending cut by 10%
  • Prosperity Rule: If CWR < 80% of IWR AND the prior year's total portfolio return was positive → spending raised by 10%
  • 1-year cooldown: No back-to-back guardrail adjustments (prevents every-other-year spiral)
  • Cumulative bounds: spending multiplier clamped to [0.85, 1.25] (max 15% cut / 25% raise from phase baseline)
  • IWR baseline resets at spending phase transitions and when Social Security income first activates
Bucket Strategy: Cash buffer sized at 2× grossed-up annual spend (including tax gross-up, not raw spend); buffer capped at 50% of portfolio to protect growth engine
Drift-Band Rebalancing: ±5% absolute equity ratio band; proportional sell within band, full rebalance outside
RMD: SECURE 2.0 / IRS Pub 590-B; mandatory floor enforced (if RMD > spending need, RMD sets the withdrawal)
Tax Gross-Up: blended effective rate = withdrawalTaxRate × (taxDeferredRatio/100); spending grossed up so portfolio withdrawal funds both spend and taxes
Social Security Tax: Up to 85% of Social Security benefits are modeled as taxable at your withdrawal tax rate, reducing their net offset to your portfolio withdrawal.
All portfolio values are in real (today's) dollars; nominalWithdrawal for 1099-R reference uses cumulative stochastic inflation
Scenario Bands: P${inputs.percentileAverage} (green), P${inputs.percentileBelowAverage} (gold), P${inputs.percentileDownturn} (red) of 100,000 runs

--- SIMULATION RESULTS ---
Success Rate: ${results.successRate.toFixed(1)}% (portfolio balance never fell to $1 or below at any point during the ${inputs.timeHorizon}-year term)
P${inputs.percentileAverage} Representative Final Value (real today's $): $${results.finalMedianValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
Annualised Portfolio Volatility: ${results.volatility.toFixed(1)}%

--- AUDIT LOG SAMPLE — P${inputs.percentileAverage} Run, First 10 Years ---
(All $ in real today's dollars. Math check: Start + Growth − Fees − Total Draw = End; Total Draw = Spend + Tax withheld)
${auditSample}

--- QUESTIONS FOR YOUR REVIEW ---
1. Is the success rate appropriate given the spending and allocation?
2. Are there any IRS compliance concerns (RMD timing, tax gross-up, SS offset)?
3. Does the spending plan appear sustainable through the full ${inputs.timeHorizon}-year horizon?
4. Are the Guyton-Klinger adjustments (if any, see audit) appropriate given the withdrawal rate?
5. Any red flags in the first-year withdrawal math or fee structure?
`;
  }, [inputs, results, selectedStrategy, startYear]);


  const runTime = new Date(results.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const formatCurrency = (val: number) => {
    const sign = val < 0 ? '-' : '';
    const abs = Math.abs(val);
    if (abs >= 1000000) return `${sign}$${(abs / 1000000).toFixed(1)}M`;
    if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(0)}k`;
    return `${sign}$${Math.round(abs).toLocaleString()}`;
  };

  const getStrategyLabel = (s: StrategyType): string => {
    switch (s) {
      case 'BUCKET': return 'Bucket Strategy';
      case 'CONSERVATIVE': return '60/40 Split (60% Stock / 40% Bond)';
      case 'AGGRESSIVE': return '70/30 Split (70% Stock / 30% Bond)';
      case 'CUSTOM': return `Custom Allocation (${inputs.customStockAllocation}% Stock / ${100 - inputs.customStockAllocation}% Bond)`;
    }
  };

  const getStrategyDescription = (s: StrategyType) => {
    if (s === 'BUCKET') {
      return (
        <>
          <p className="mb-4">
            This strategy divides your portfolio into two distinct buckets to mitigate risk:
          </p>
          <ul className="list-disc pl-4 space-y-2 mb-4">
            <li><strong>Cash Bucket:</strong> Holds approximately 2 years of grossed-up living expenses (including estimated taxes on pre-tax withdrawals) in safe, liquid assets.</li>
            <li><strong>Growth Bucket:</strong> The remainder is invested in equities for long-term growth.</li>
          </ul>
          <p className="mb-2 font-bold text-slate-700 text-[11px] uppercase tracking-wide">Rules of Operation:</p>
          <ol className="list-decimal pl-4 space-y-2">
            <li>If the market is <strong>UP</strong> (Stock Up), we sell stocks (preferring gains) to refill the Cash Bucket back to 2 years.</li>
            <li>If the market is <strong>DOWN</strong> (Stock Down), we <strong>do not sell stocks</strong>. We spend directly from the Cash Bucket, allowing stocks time to recover.</li>
            <li>Stocks are only sold in a downturn if the Cash Bucket has insufficient funds to cover that year's spending need.</li>
          </ol>
        </>
      );
    } else {
      const stockPct = s === 'CONSERVATIVE' ? 60 : s === 'AGGRESSIVE' ? 70 : inputs.customStockAllocation;
      const bondPct = 100 - stockPct;
      return (
        <>
          <p className="mb-4">
            A traditional <strong>Target Mix</strong> strategy that maintains a constant {stockPct}% Stock / {bondPct}% Bond ratio.
          </p>
          <p className="mb-2 font-bold text-slate-700 text-[11px] uppercase tracking-wide">Rules of Operation (Automatic Rebalancing):</p>
          <ul className="list-disc pl-4 space-y-2 mb-4">
            <li>
              <strong>If the mix wanders within 5%:</strong> We withdraw money normally from your existing balance without making extra trades, saving you fees.
            </li>
            <li>
              <strong>If the mix drifts off by more than 5%:</strong> A full rebalance is triggered. We automatically sell the assets that did well and buy what did poorly, getting your risk precisely back to your target.
            </li>
          </ul>
          <p>
            This 5% "buffer" eliminates unnecessary fees in calm markets while forcing you to "buy low and sell high" when things shift dramatically.
          </p>
        </>
      )
    }
  }

  const handleStrategyChange = (s: StrategyType) => {
    setSelectedStrategy(s);
  };

  const handleExportReport = () => {
    window.print();
  };

  const handleDownloadCSV = () => {
    // Honour the view-duration filter so the exported data matches what is
    // shown on screen (e.g. if user chose "10 Years", CSV has 10 years too).
    const dataToExport = viewDuration === 'MAX'
      ? results.data
      : results.data.filter(d => d.year <= startYear + viewDuration);

    const headers = ['Year', 'Average Market', 'Below Average', 'Downturn'];
    const rows = dataToExport.map(d => [
      d.year,
      d.average != null ? d.average.toFixed(2) : '0.00',
      d.belowAverage != null ? d.belowAverage.toFixed(2) : '0.00',
      d.downturn != null ? d.downturn.toFixed(2) : '0.00'
    ]);


    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `retirement_simulation_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleCustomSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = parseInt(e.target.value);
    onCustomAllocationChange(newVal);
  }

  const getAuditData = (): AuditRow[] => {
    switch (auditScenario) {
      case 'AVERAGE': return results.auditLogAverage;
      case 'BELOW': return results.auditLogBelowAverage;
      case 'DOWNTURN': return results.auditLogDownturn;
      default: return results.auditLogDownturn;
    }
  }

  const visibleData = useMemo(() => {
    let dataToUse = results.data;
    if (viewDuration !== 'MAX') {
      dataToUse = results.data.filter(d => d.year <= startYear + viewDuration);
    }

    // Process for "disappearing line" effect when value hits 0
    let avgDepleted = false;
    let belowDepleted = false;
    let downDepleted = false;

    return dataToUse.map(d => {
      const newD = { ...d };

      // "Disappearing line" effect: first zero shows as 0 (line touches the axis),
      // every subsequent zero shows as null (Recharts leaves a gap).
      // Depletion is PERMANENT in this model, so the flags must never reset to
      // false — the removed `else` branches prevented floating-point noise from
      // briefly producing a tiny positive value that would re-enable the zero
      // display and cause a spurious line re-appearance.
      if (d.average <= 0) {
        newD.average = avgDepleted ? null : 0;
        avgDepleted = true;
      }
      if (d.belowAverage <= 0) {
        newD.belowAverage = belowDepleted ? null : 0;
        belowDepleted = true;
      }
      if (d.downturn <= 0) {
        newD.downturn = downDepleted ? null : 0;
        downDepleted = true;
      }

      return newD;
    });

  }, [results.data, viewDuration, startYear]);

  return (
    <div className="min-h-screen bg-background-light dark:bg-background-dark text-slate-800 dark:text-slate-200 animate-fade-in transition-colors duration-300">
      {/* Navbar */}
      <nav className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-50 transition-colors duration-300">
        <div className="max-w-[1440px] mx-auto px-6 md:px-10 h-20 flex items-center justify-between">
          <div className="flex items-center gap-5">
            <div>
              <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 hidden md:block">Retirement Simulation Analysis</h1>
              <p className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Monte Carlo Engine</p>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <button
              onClick={onToggleDarkMode}
              className="w-10 h-10 bg-slate-50 dark:bg-slate-800 flex items-center justify-center rounded-xl shadow-sm cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors border border-slate-200 dark:border-slate-700"
              aria-label="Toggle theme"
            >
              <span className="material-symbols-outlined text-slate-600 dark:text-slate-400 text-xl">
                {isDarkMode ? 'light_mode' : 'dark_mode'}
              </span>
            </button>
            <div className="hidden md:flex items-center gap-3 px-5 py-2 bg-slate-50 dark:bg-slate-800/50 rounded-full border border-slate-200 dark:border-slate-800 transition-colors">
              <span className="text-[11px] text-slate-400 dark:text-slate-500 font-semibold uppercase tracking-wider">Success Rate</span>
              <span className={`text-xs font-bold ${results.successRate > 90 ? 'text-emerald-600 dark:text-emerald-500' : results.successRate > 75 ? 'text-amber-600 dark:text-amber-500' : 'text-red-600 dark:text-red-500'}`}>
                {results.successRate.toFixed(1)}% ({results.successRate > 90 ? 'High' : results.successRate > 75 ? 'Moderate' : 'Low'})
              </span>
            </div>
            <button
              onClick={handleExportReport}
              aria-label="Export simulation report"
              className="bg-green-600 text-white px-6 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-green-700 transition-all flex items-center gap-2 shadow-md cursor-pointer"
            >
              <span className="material-symbols-outlined text-lg">download_for_offline</span>
              <span className="hidden md:inline">Export Report</span>
            </button>
          </div>
        </div>
      </nav>

      {/* Sub-header Inputs Summary */}
      <div className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shadow-sm transition-colors duration-300 sticky top-20 z-40">
        <div className="max-w-[1440px] mx-auto px-6 md:px-10 py-4 flex items-center justify-between overflow-x-auto gap-8 no-scrollbar">
          <div className="flex items-center gap-10 shrink-0">
            <div className="flex flex-col">
              <span className="text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-wider">Total Portfolio</span>
              <span className="text-sm font-bold text-slate-800 dark:text-slate-200">${(inputs.initialCash + inputs.initialInvestments).toLocaleString()}</span>
            </div>
            <div className="w-px h-8 bg-slate-200 dark:bg-slate-800"></div>
            <div className="flex flex-col">
              <span className="text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-wider">Initial Annual Spend</span>
              <span className="text-sm font-bold text-slate-800 dark:text-slate-200">
                ${inputs.spendingPhases[0]?.annualSpend?.toLocaleString() ?? '—'}
                {inputs.spendingPhases.length > 1 && (
                  <span className="text-[10px] font-normal text-slate-400 dark:text-slate-500 ml-1">
                    +{inputs.spendingPhases.length - 1} tier{inputs.spendingPhases.length > 2 ? 's' : ''}
                  </span>
                )}
              </span>
            </div>
            <div className="w-px h-8 bg-slate-200 dark:bg-slate-800"></div>
            <div className="flex flex-col">
              <span className="text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-wider">Start Year</span>
              <span className="text-sm font-bold text-slate-800 dark:text-slate-200">{startYear}</span>
            </div>
            <div className="w-px h-8 bg-slate-200 dark:bg-slate-800"></div>
            <div className="flex flex-col">
              <span className="text-[11px] uppercase font-semibold text-slate-400 dark:text-slate-500 tracking-wider">Time Horizon</span>
              <span className="text-sm font-bold text-slate-800 dark:text-slate-200">{inputs.timeHorizon} Years</span>
            </div>
          </div>
          <button
            onClick={onEdit}
            aria-label="Adjust simulation inputs"
            className="flex items-center gap-2 text-xs font-bold text-white hover:text-white px-5 py-2.5 bg-green-600 hover:bg-green-700 rounded-lg shadow-md transition-all whitespace-nowrap cursor-pointer uppercase tracking-wider"
          >
            <span className="material-symbols-outlined text-sm leading-none">settings_input_component</span>
            Adjust Inputs
          </button>
        </div>
      </div>

      <main className="max-w-[1440px] mx-auto px-6 md:px-10 py-10">
        {/* Strategy Tabs */}
        <div className="mb-5 border-b border-slate-200 dark:border-slate-800 transition-colors overflow-x-auto">
          <div className="flex gap-8 md:gap-12 min-w-max" role="tablist" aria-label="Investment strategies">
            {(['BUCKET', 'CONSERVATIVE', 'AGGRESSIVE', 'CUSTOM'] as StrategyType[]).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={selectedStrategy === t}
                onClick={() => handleStrategyChange(t)}
                className={`pb-5 text-sm font-medium transition-all border-b-2 ${selectedStrategy === t
                  ? 'text-slate-900 dark:text-slate-100 border-primary font-bold'
                  : 'text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 border-transparent'
                  }`}
              >
                {t === 'BUCKET' && 'Bucket Strategy'}
                {t === 'CONSERVATIVE' && '60/40 Split'}
                {t === 'AGGRESSIVE' && '70/30 Split'}
                {t === 'CUSTOM' && (
                  <span className="flex items-center gap-2">
                    Custom Allocation
                    {selectedStrategy === 'CUSTOM' && <span className="bg-primary/20 dark:bg-primary/10 text-slate-800 dark:text-primary text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-tighter">Live</span>}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap justify-start items-center mb-6 gap-6">
          <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 hidden md:block">Analysis Dashboard</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              role="switch"
              aria-checked={isSidebarOpen}
              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${isSidebarOpen ? 'bg-primary' : 'bg-slate-300 dark:bg-slate-600'}`}
            >
              <span className="sr-only">Toggle Sidebar</span>
              <span
                aria-hidden="true"
                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${isSidebarOpen ? 'translate-x-5' : 'translate-x-0'}`}
              />
            </button>
            <span
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="text-xs font-bold text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200 transition-colors uppercase tracking-wider cursor-pointer"
            >
              {isSidebarOpen ? 'Hide Insights' : 'Show Insights'}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-5">
          {/* Sidebar Insights (Moved to Left) */}
          {isSidebarOpen && (
            <aside className="col-span-12 lg:col-span-3 space-y-8">
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 shadow-sm relative overflow-hidden transition-all duration-300">
                <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 dark:bg-primary/5 rounded-full -mr-16 -mt-16 transition-colors"></div>
                <div className="relative">
                  <h3 className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-6 flex items-center gap-2 transition-colors">
                    <span className="material-symbols-outlined text-lg text-primary">info</span>
                    Strategy Insight
                  </h3>
                  <div className="space-y-6 text-xs leading-relaxed text-slate-500 dark:text-slate-400 font-medium transition-colors">
                    {getStrategyDescription(selectedStrategy)}
                    <div className="space-y-4 pt-2">
                      <h4 className="text-[11px] font-bold text-slate-900 dark:text-slate-200 uppercase tracking-wider transition-colors">Active Weights (Target)</h4>
                      <div className="space-y-4">
                        <div>
                          <div className="flex justify-between items-center text-[11px] mb-2">
                            <span className="text-slate-500 dark:text-slate-400 font-bold transition-colors">Liquid / Cash</span>
                            <span className="font-bold text-slate-900 dark:text-slate-200 transition-colors">{(results.allocation.cash * 100).toFixed(1)}%</span>
                          </div>
                          <div className="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full transition-colors">
                            <div className="bg-primary h-full rounded-full" style={{ width: `${results.allocation.cash * 100}%` }}></div>
                          </div>
                        </div>
                        <div>
                          <div className="flex justify-between items-center text-[11px] mb-2">
                            <span className="text-slate-500 dark:text-slate-400 font-bold transition-colors">Bonds</span>
                            <span className="font-bold text-slate-900 dark:text-slate-200 transition-colors">{(results.allocation.bond * 100).toFixed(1)}%</span>
                          </div>
                          <div className="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full transition-colors">
                            <div className="bg-slate-500 h-full rounded-full" style={{ width: `${results.allocation.bond * 100}%` }}></div>
                          </div>
                        </div>
                        <div>
                          <div className="flex justify-between items-center text-[11px] mb-2">
                            <span className="text-slate-500 dark:text-slate-400 font-bold transition-colors">Equities</span>
                            <span className="font-bold text-slate-900 dark:text-slate-200 transition-colors">{(results.allocation.stock * 100).toFixed(1)}%</span>
                          </div>
                          <div className="w-full bg-slate-100 dark:bg-slate-800 h-1.5 rounded-full transition-colors">
                            <div className="bg-green-600 h-full rounded-full" style={{ width: `${results.allocation.stock * 100}%` }}></div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 text-center shadow-sm transition-all duration-300">
                <p className="text-[11px] font-semibold text-primary uppercase mb-2 tracking-wider">Simulation Core</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-6 leading-relaxed transition-colors">Each of the 100,000 simulated futures draws random stock returns, bond returns, and inflation &mdash; correlated the way real markets behave, including rare crash events modeled at a 2% annual probability.</p>
              </div>

              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm transition-all duration-300">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-[10px] font-semibold text-purple-600 dark:text-purple-400 uppercase tracking-wider">Prompt for AI Validation</p>
                  <button onClick={() => navigator.clipboard.writeText(aiPromptText)} className="text-slate-400 hover:text-purple-600 transition-colors cursor-pointer" title="Copy to clipboard">
                    <span className="material-symbols-outlined text-sm">content_copy</span>
                  </button>
                </div>
                <div className="bg-slate-50 dark:bg-slate-800 rounded p-3 h-55 overflow-y-auto custom-scrollbar border border-slate-100 dark:border-slate-700">
                  <pre className="text-[10px] text-slate-600 dark:text-slate-400 whitespace-pre-wrap font-mono leading-relaxed font-medium">
                    {aiPromptText}
                  </pre>
                </div>
              </div>
            </aside>
          )}

          <div className={`col-span-12 ${isSidebarOpen ? 'lg:col-span-9' : 'lg:col-span-12'} transition-all duration-300`}>

            {/* Chart Container */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 md:p-10 shadow-sm mb-5 transition-colors duration-300">
              <div className="flex flex-col md:flex-row md:items-end justify-between mb-8 gap-6">
                <div>
                  <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-1">Portfolio Projection</h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">100,000 market scenarios simulated <span className="text-slate-300 dark:text-slate-700 mx-2">•</span> Last Run: {runTime}</p>
                </div>

                <div className="flex flex-col md:items-end gap-4">
                  {/* Time Horizon Buttons */}
                  <div className="bg-slate-50 dark:bg-slate-800/50 p-1 rounded-lg border border-slate-200 dark:border-slate-800 flex flex-wrap gap-1 transition-colors">
                    {[5, 10, 15, 20].map(year => (
                      <button
                        key={year}
                        onClick={() => setViewDuration(year)}
                        className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${viewDuration === year
                          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm border border-slate-100 dark:border-slate-800'
                          : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                          }`}
                      >
                        {year} Years
                      </button>
                    ))}
                    <button
                      onClick={() => setViewDuration('MAX')}
                      className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${viewDuration === 'MAX'
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm border border-slate-100 dark:border-slate-800'
                        : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                    >
                      Full View
                    </button>
                  </div>

                  {/* Legend */}
                  <div className="flex flex-wrap items-center gap-4 md:gap-6">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-growth-green"></span>
                      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Average Market</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-below-avg-gold"></span>
                      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Below Average</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-downturn-red"></span>
                      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Downturn</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Custom Allocation Slider */}
              {selectedStrategy === 'CUSTOM' && (
                <div className="mb-8 p-6 bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-800 rounded-xl animate-in fade-in slide-in-from-top-2">
                  <div className="flex justify-between items-center mb-4">
                    <label className="text-xs font-bold text-slate-800 dark:text-slate-200 uppercase tracking-wider">
                      Stock / Bond Allocation
                    </label>
                    <span className="text-sm font-bold bg-white dark:bg-slate-900 px-3 py-1 rounded border border-slate-200 dark:border-slate-800 shadow-sm dark:text-slate-100">
                      {inputs.customStockAllocation}% Stocks / {100 - inputs.customStockAllocation}% Bonds
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-xs font-bold text-slate-400 dark:text-slate-500 w-16 text-right">0% Equity</span>
                    <input
                      className="w-full h-2 bg-slate-200 dark:bg-slate-700 accent-primary rounded-lg appearance-none cursor-pointer"
                      max="100" min="0" step="5"
                      type="range"
                      value={inputs.customStockAllocation}
                      onChange={handleCustomSliderChange}
                    />
                    <span className="text-xs font-bold text-slate-400 dark:text-slate-500 w-16">100% Equity</span>
                  </div>
                </div>
              )}

              {/* Chart Area */}
              <div className="relative h-[400px] md:h-[500px] w-full rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/20 dark:bg-slate-800/10 p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={visibleData} margin={{ top: 20, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorAvg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#16a34a" stopOpacity={0.1} />
                        <stop offset="95%" stopColor="#16a34a" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorBelow" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#d97706" stopOpacity={0.1} />
                        <stop offset="95%" stopColor="#d97706" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorDown" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#dc2626" stopOpacity={0.1} />
                        <stop offset="95%" stopColor="#dc2626" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDarkMode ? '#1e293b' : '#e2e8f0'} />
                    <XAxis
                      dataKey="year"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: isDarkMode ? '#64748b' : '#94a3b8', fontSize: 11, fontWeight: 'bold' }}
                      dy={10}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: isDarkMode ? '#64748b' : '#94a3b8', fontSize: 11, fontWeight: 'bold' }}
                      tickFormatter={formatCurrency}
                      dx={-10}
                    />
                    <Tooltip content={<CustomTooltip startYear={startYear} />} cursor={{ stroke: isDarkMode ? '#334155' : '#cbd5e1', strokeWidth: 1, strokeDasharray: '5 5' }} />
                    <Area
                      type="monotone"
                      dataKey="average"
                      name="Average Market"
                      stroke="#16a34a"
                      strokeWidth={1}
                      fillOpacity={1}
                      fill="url(#colorAvg)"
                      connectNulls={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="belowAverage"
                      name="Below Average"
                      stroke="#d97706"
                      strokeWidth={1}
                      fillOpacity={1}
                      fill="url(#colorBelow)"
                      connectNulls={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="downturn"
                      name="Downturn"
                      stroke="#dc2626"
                      strokeWidth={1}
                      fillOpacity={1}
                      fill="url(#colorDown)"
                      connectNulls={false}
                    />
                    <ReferenceLine y={0} stroke="#dc2626" strokeDasharray="3 3" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Chart Explanation */}
              <div className="mt-8 p-6 bg-blue-50/50 dark:bg-blue-900/10 rounded-xl border border-blue-100 dark:border-blue-900/30 transition-colors">
                <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100 mb-2 flex items-center gap-2">
                  <span className="material-symbols-outlined text-lg text-blue-600 dark:text-blue-400">help</span>
                  How to read this chart
                </h4>
                <div className="p-6 bg-slate-50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 grid grid-cols-1 md:grid-cols-3 gap-6 transition-colors">
                  <div>
                    <span className="block font-bold text-growth-green text-xs mb-1">Average Market &mdash; P{inputs.percentileAverage} (Green)</span>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      This line is the P{inputs.percentileAverage} outcome &mdash; {inputs.percentileAverage}% of the 100,000 simulated futures ended below this value, and {100 - inputs.percentileAverage}% ended above it. Use as your primary planning baseline.
                    </p>
                  </div>
                  <div>
                    <span className="block font-bold text-below-avg-gold text-xs mb-1">Below Average &mdash; P{inputs.percentileBelowAverage} (Gold)</span>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      This line is the P{inputs.percentileBelowAverage} outcome &mdash; only {inputs.percentileBelowAverage}% of simulations ended lower than this. Shows a persistently slow-growth market. Good for conservative planning.
                    </p>
                  </div>
                  <div>
                    <span className="block font-bold text-downturn-red text-xs mb-1">Downturn &mdash; P{inputs.percentileDownturn} (Red)</span>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                      This is the worst P{inputs.percentileDownturn} stress test &mdash; only {inputs.percentileDownturn}% of all simulations ended worse than this line. {100 - inputs.percentileDownturn}% survived better. If this line stays above $0, your plan is extremely resilient.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Detailed Data Table */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-sm overflow-hidden mb-5 transition-colors duration-300">
              <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 transition-colors">
                <div className="flex items-center gap-4">
                  <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                    {auditMode ? 'Audit Strategy Log' : 'Yearly Balance Projection'}
                  </h3>
                  {/* Checkbox Button */}
                  <label className="flex items-center gap-3 cursor-pointer select-none group ml-4">
                    <div className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${auditMode ? 'bg-primary border-primary dark:bg-primary dark:border-primary' : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 group-hover:border-primary'}`}>
                      <span className={`material-symbols-outlined text-[14px] font-bold text-slate-900 dark:text-slate-900 transition-opacity ${auditMode ? 'opacity-100' : 'opacity-0'}`}>check</span>
                    </div>
                    <input
                      type="checkbox"
                      className="hidden"
                      checked={auditMode}
                      onChange={() => setAuditMode(!auditMode)}
                    />
                    <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider group-hover:text-slate-800 transition-colors">Audit Mode (Verify Math)</span>
                  </label>
                </div>

                <div className="flex items-center gap-4 w-full md:w-auto justify-between md:justify-end">
                  {!auditMode && <span className="text-[11px] text-slate-400 dark:text-slate-500 font-semibold hidden md:inline tracking-wider">Last Updated: {runTime}</span>}
                  {auditMode && (
                    <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-lg transition-colors">
                      <button
                        onClick={() => setAuditScenario('AVERAGE')}
                        className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${auditScenario === 'AVERAGE' ? 'bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-400 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                      >
                        Average Market (P{inputs.percentileAverage})
                      </button>
                      <button
                        onClick={() => setAuditScenario('BELOW')}
                        className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${auditScenario === 'BELOW' ? 'bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-400 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                      >
                        Below Average (P{inputs.percentileBelowAverage})
                      </button>
                      <button
                        onClick={() => setAuditScenario('DOWNTURN')}
                        className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${auditScenario === 'DOWNTURN' ? 'bg-white dark:bg-slate-900 text-red-700 dark:text-red-400 shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}`}
                      >
                        Downturn (P{inputs.percentileDownturn})
                      </button>
                    </div>
                  )}
                  <button
                    onClick={handleDownloadCSV}
                    className="flex items-center gap-2 text-xs font-bold text-white hover:text-white px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg shadow-md transition-all whitespace-nowrap cursor-pointer uppercase tracking-wider"
                  >
                    <span>Download CSV</span>
                    <span className="material-symbols-outlined text-sm leading-none">download</span>
                  </button>
                </div>
              </div>

              {/* ── Audit Legend ─────────────────────────────────── */}
              {auditMode && (
                <div className="mx-6 mb-4 p-4 bg-slate-50 dark:bg-slate-800/60 rounded-xl border border-slate-200 dark:border-slate-700 transition-colors">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-3">Audit Legend — How to Read This Table</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-[11px] text-slate-600 dark:text-slate-400">
                    <div className="flex items-start gap-2">
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-400 font-bold whitespace-nowrap shrink-0">
                        <span className="material-symbols-outlined text-xs leading-none">bolt</span>Crash Event
                      </span>
                      <span>Market Crash Event: About a 2% chance each year of a sudden 20–40% drop in stocks on top of normal market ups and downs.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 font-bold whitespace-nowrap shrink-0">
                        <span className="material-symbols-outlined text-xs leading-none">shield</span>Capital Preservation
                      </span>
                      <span>Safety Guardrail Triggered: Your gross portfolio withdrawal rate exceeded 120% of the rate set in your first retirement year &mdash; meaning your portfolio is shrinking faster than your spending justifies. Spending was automatically reduced by 10% to extend your portfolio&apos;s life.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 font-bold whitespace-nowrap shrink-0">
                        <span className="material-symbols-outlined text-xs leading-none">trending_up</span>Prosperity Rule
                      </span>
                      <span>Prosperity Guardrail Triggered: Your gross portfolio withdrawal rate dropped below 80% of the rate set in your first retirement year &mdash; your portfolio is very healthy. Spending was safely raised by 10%!</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 font-bold whitespace-nowrap shrink-0">
                        <span className="material-symbols-outlined text-xs leading-none">verified</span>RMD: $X (met)
                      </span>
                      <span>Required Minimum Distribution (RMD): IRS rules (SECURE 2.0 / Pub. 590-B) require a minimum annual withdrawal from Traditional 401(k) and IRA accounts once you reach your RMD age. If your living expenses are less than the RMD, the RMD becomes your withdrawal floor for that year &mdash; and you owe income tax on the full RMD amount.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="font-bold text-amber-600 dark:text-amber-400 whitespace-nowrap shrink-0">GK Multiplier &times;X.XXX</span>
                      <span>Spending Changes Over Time: Shows how much your original spending has been cut or raised long-term by the Safety/Bonus rules.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="font-bold text-purple-500 dark:text-purple-400 whitespace-nowrap shrink-0">Infl: X.X% (purple)</span>
                      <span>Actual Inflation: The exact inflation for this specific year (which randomly jumps around your expected average).</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="font-bold text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">Nominal (1099-R): ~$X</span>
                      <span>Future Dollars (Form 1099-R): The dollar amount that will actually appear on your tax form years from now, adjusted for inflation.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="font-bold text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">Total Draw = Spend + Tax</span>
                      <span>Portfolio is reduced by <em>gross</em> withdrawal (spend need + blended tax on deferred accounts). Tax is withheld from the distribution, not paid separately.</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-3 border-t border-slate-200 dark:border-slate-700 pt-2">
                    Math check: <strong>Start Balance + Growth &minus; Fees &minus; Total Draw = End Balance</strong> for every row. All values in real (today&apos;s) dollars unless &ldquo;Nominal&rdquo; is specified. <em>Growth is pre-fee gross return; Total Draw is the gross portfolio withdrawal including tax withholding.</em>
                  </p>
                </div>
              )}

              <div className="overflow-x-auto custom-scrollbar">
                <table className="w-full text-sm text-left relative">
                  {auditMode ? (
                    // AUDIT TABLE HEADERS
                    <thead className="text-xs text-slate-500 dark:text-slate-400 uppercase font-bold tracking-wider transition-colors">
                      <tr>
                        <th className="px-4 py-4 bg-slate-50 dark:bg-slate-800/80 text-slate-800 dark:text-slate-200 sticky top-0 z-20 shadow-sm">Year / Age</th>
                        <th className="px-4 py-4 bg-slate-50 dark:bg-slate-800/80 text-emerald-600 dark:text-emerald-500 sticky top-0 z-20 shadow-sm">SS / Pension</th>
                        <th className="px-4 py-4 bg-slate-50 dark:bg-slate-800/80 text-slate-800 dark:text-slate-200 sticky top-0 z-20 shadow-sm">Start Balance</th>
                        <th className="px-4 py-4 bg-slate-50 dark:bg-slate-800/80 text-slate-800 dark:text-slate-200 sticky top-0 z-20 shadow-sm">
                          Real Returns
                          <div className="text-[9px] text-purple-500 dark:text-purple-400 normal-case font-normal tracking-normal mt-0.5">incl. actual inflation check</div>
                        </th>
                        <th className="px-4 py-4 bg-slate-50 dark:bg-slate-800/80 text-slate-800 dark:text-slate-200 sticky top-0 z-20 shadow-sm">Growth</th>
                        <th className="px-4 py-4 bg-slate-50 dark:bg-slate-800/80 text-amber-600 dark:text-amber-500 sticky top-0 z-20 shadow-sm">Fees</th>
                        <th className="px-4 py-4 bg-slate-50 dark:bg-slate-800/80 text-slate-800 dark:text-slate-200 sticky top-0 z-20 shadow-sm">
                          Guardrail &amp; Strategy Action
                          <div className="text-[9px] text-slate-400 dark:text-slate-500 normal-case font-normal tracking-normal mt-0.5">Automatic spending adjustments + rebalancing actions</div>
                        </th>
                        <th className="px-4 py-4 bg-slate-50 dark:bg-slate-800/80 text-slate-800 dark:text-slate-200 sticky top-0 z-20 shadow-sm">
                          Withdrawal (today's $)
                          <div className="text-[9px] text-slate-400 dark:text-slate-500 normal-case font-normal tracking-normal mt-0.5">incl. nominal for 1099-R</div>
                        </th>
                        <th className="px-4 py-4 bg-slate-50 dark:bg-slate-800/80 text-slate-800 dark:text-slate-200 sticky top-0 z-20 shadow-sm">End Balance</th>
                      </tr>
                    </thead>
                  ) : (
                    // NORMAL TABLE HEADERS
                    <thead className="text-xs text-slate-500 dark:text-slate-400 uppercase font-bold tracking-wider transition-colors">
                      <tr>
                        <th className="px-6 py-4 bg-slate-50 dark:bg-slate-800/80 sticky top-0 z-20 shadow-sm transition-colors">Year</th>
                        <th className="px-6 py-4 bg-slate-50 dark:bg-slate-800/80 text-growth-green dark:text-green-500 sticky top-0 z-20 shadow-sm transition-colors">
                          Average Market
                          <div className="text-[9px] font-normal normal-case tracking-normal mt-0.5 opacity-70">P{inputs.percentileAverage} of 100k runs</div>
                        </th>
                        <th className="px-6 py-4 bg-slate-50 dark:bg-slate-800/80 text-below-avg-gold dark:text-amber-500 sticky top-0 z-20 shadow-sm transition-colors">
                          Below Average
                          <div className="text-[9px] font-normal normal-case tracking-normal mt-0.5 opacity-70">P{inputs.percentileBelowAverage} of 100k runs</div>
                        </th>
                        <th className="px-6 py-4 bg-slate-50 dark:bg-slate-800/80 text-downturn-red dark:text-red-500 sticky top-0 z-20 shadow-sm transition-colors">
                          Downturn
                          <div className="text-[9px] font-normal normal-case tracking-normal mt-0.5 opacity-70">P{inputs.percentileDownturn} of 100k runs</div>
                        </th>
                      </tr>
                    </thead>
                  )}

                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800 transition-colors">
                    {auditMode ? (
                      // AUDIT TABLE ROWS
                      getAuditData().map((row) => (
                        <tr key={row.year} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                          <td className="px-4 py-4 font-bold text-slate-700 dark:text-slate-300 leading-tight">
                            {row.year}
                            {row.year - startYear > 0 && (
                              <div className="text-[10px] text-slate-400 dark:text-slate-500 font-normal">
                                ({row.year - startYear} yrs)
                              </div>
                            )}
                            <div className="text-[10px] text-slate-400 dark:text-slate-500 font-normal">
                              Age {inputs.currentAge + (row.year - startYear)}
                            </div>
                          </td>
                          {/* SS / Pension — now in column 2 so it's always visible without horizontal scrolling */}
                          <td className="px-4 py-4 font-medium transition-colors">
                            {row.ssIncome > 0 ? (
                              <div className="text-emerald-600 dark:text-emerald-500 font-bold">
                                +${row.ssIncome.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                              </div>
                            ) : (
                              <div className="text-slate-300 dark:text-slate-600">—</div>
                            )}
                          </td>
                          <td className="px-4 py-4 font-medium text-slate-600 dark:text-slate-400 text-xs text-right md:text-left transition-colors">
                            <div className="font-bold text-slate-700 dark:text-slate-300">${(row.startCash + row.startStock + row.startBond).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                            {row.startStock > 0 && <div className="text-[10px] text-emerald-600 dark:text-emerald-500">Stk ${row.startStock.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>}
                            {row.startBond > 0 && <div className="text-[10px] text-blue-500 dark:text-blue-400">Bnd ${row.startBond.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>}
                            {row.startCash > 0 && <div className="text-[10px] text-slate-400 dark:text-slate-500">Csh ${row.startCash.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>}
                          </td>
                          <td className="px-4 py-4 text-xs font-medium">
                            {/* Jump-diffusion crash flag — annotates years where the 2 % annual
                                black-swan event fired (Merton 1976), producing the extra-large
                                equity drawdown beyond normal log-normal variance. */}
                            {row.crashed && (
                              <div className="mb-1.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-orange-50 dark:bg-orange-950/30 text-orange-700 dark:text-orange-400 border border-orange-200 dark:border-orange-800 flex items-center gap-1 uppercase tracking-wide">
                                <span className="material-symbols-outlined text-xs leading-none">bolt</span>
                                Crash Event
                              </div>
                            )}
                            <div className={`${row.stockReturn >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                              Stock: {(row.stockReturn * 100).toFixed(1)}%
                            </div>
                            {selectedStrategy !== 'BUCKET' && (
                              <div className={`${row.bondReturn >= 0 ? 'text-blue-600 dark:text-blue-400' : 'text-red-600 dark:text-red-400'}`}>
                                Bond: {(row.bondReturn * 100).toFixed(1)}%
                              </div>
                            )}
                            {selectedStrategy === 'BUCKET' && (
                              <div className="text-slate-400 dark:text-slate-500">
                                Cash: {(row.cashReturn * 100).toFixed(1)}%
                              </div>
                            )}
                            {/* Realised stochastic inflation — varies from the user's mean input */}
                            <div className={`mt-0.5 border-t border-slate-100 dark:border-slate-800 pt-0.5 ${row.realizedInflation > 0 ? 'text-purple-500 dark:text-purple-400' : 'text-blue-500 dark:text-blue-400'}`}>
                              Infl: {(row.realizedInflation * 100).toFixed(1)}%
                            </div>
                          </td>
                          <td className={`px-4 py-4 font-bold ${row.growthAmount >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-downturn-red dark:text-red-400'}`}>
                            {row.growthAmount >= 0 ? '+' : ''}${row.growthAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                          <td className="px-4 py-4 font-bold text-amber-600 dark:text-amber-500">
                            -${row.feesAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                          <td className="px-4 py-4 text-xs font-medium text-slate-700 dark:text-slate-400 leading-relaxed transition-colors">
                            {/* Guyton-Klinger guardrail event — styled as a distinct badge so it
                                is never confused with the mechanical strategy action below it. */}
                            {row.gkEvent && (
                              <div className={`mb-2 px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 ${row.gkEvent.startsWith('Safety')
                                  ? 'bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400'
                                  : 'bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400'
                                }`}>
                                <span className="material-symbols-outlined text-xs leading-none">
                                  {row.gkEvent.startsWith('Safety') ? 'shield' : 'trending_up'}
                                </span>
                                {row.gkEvent}
                              </div>
                            )}
                            {/* Mechanical strategy action (rebalance, bucket refill, etc.) */}
                            <div>{row.action}</div>
                            {/* Accumulated G-K spend multiplier — shown whenever it deviates from
                                the baseline so users can see the compounding effect over years. */}
                            {Math.abs(row.spendMultiplier - 1.0) > 0.001 && (
                              <div className="mt-1 text-[9px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wide">
                                GK Multiplier: ×{row.spendMultiplier.toFixed(3)}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-4 font-medium text-slate-600 dark:text-slate-400 transition-colors">
                            <div>
                              Spend: -${(row.withdrawal - row.taxPaid).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </div>
                            {/* Tax line — grey when $0, red when positive — lets users verify
                                the tax gross-up is being applied for all strategies. */}
                            <div className={row.taxPaid > 0 ? 'text-red-600 dark:text-red-400' : 'text-slate-300 dark:text-slate-600'}>
                              Tax: {row.taxPaid > 0 ? `-$${row.taxPaid.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '$0'}
                            </div>
                            <div className="font-bold border-t border-slate-200 dark:border-slate-700 mt-1 pt-1 text-slate-800 dark:text-slate-200">
                              Total Draw: {row.withdrawal < 0 ? '+' : '-'}${Math.abs(row.withdrawal).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </div>
                            {/* Nominal (future-dollar) figure uses the actual cumulative product of
                                stochastic inflation draws — not a fixed-rate approximation.
                                This is the 1099-R reference amount the retiree would see. */}
                            <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-1">
                              Nominal (1099-R): ~${row.nominalWithdrawal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </div>
                            {row.rmdAmount > 0 && (
                              <div className={`mt-1 px-1.5 py-0.5 rounded text-[9px] font-bold border inline-flex items-center gap-1 uppercase tracking-wide ${row.withdrawal >= row.rmdAmount - 1
                                  ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800'
                                  : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800'
                                }`}>
                                <span className="material-symbols-outlined text-xs leading-none">
                                  {row.withdrawal >= row.rmdAmount - 1 ? 'verified' : 'warning'}
                                </span>
                                RMD: ${row.rmdAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })} {row.withdrawal >= row.rmdAmount - 1 ? '(met)' : '(VIOLATION)'}
                                {Math.abs(row.withdrawal - row.rmdAmount) < 1 && (
                                  <span className="ml-1 normal-case font-normal">— forced ↑</span>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-4 font-bold text-slate-800 dark:text-slate-200 transition-colors">
                            ${row.endTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                        </tr>
                      ))
                    ) : (
                      // NORMAL TABLE ROWS
                      visibleData.map((row) => (
                        <tr key={row.year} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                          <td className="px-6 py-4 font-bold text-slate-700 dark:text-slate-300 transition-colors">
                            {row.year}
                            {row.year - startYear > 0 && <span className="text-[10px] text-slate-400 dark:text-slate-500 font-normal ml-1">({row.year - startYear} years away)</span>}
                          </td>
                          <td className={`px-6 py-4 font-medium ${row.average === null ? 'bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-400'} transition-colors`}>
                            {row.average !== null ? `$${row.average.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'Depleted'}
                          </td>
                          <td className={`px-6 py-4 font-medium ${row.belowAverage === null ? 'bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400' : 'text-slate-600 dark:text-slate-400'} transition-colors`}>
                            {row.belowAverage !== null ? `$${row.belowAverage.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'Depleted'}
                          </td>
                          <td className={`px-6 py-4 font-medium ${row.downturn === null ? 'bg-red-100 dark:bg-red-950/40 text-red-700 dark:text-red-400' : 'text-slate-600 dark:text-slate-400'} transition-colors`}>
                            {row.downturn !== null ? `$${row.downturn.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'Depleted'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
              <div className="bg-white dark:bg-slate-900 p-8 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-2 hover:shadow-md transition-all duration-300">
                <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Success Probability</span>
                <span className="text-2xl font-bold text-slate-900 dark:text-slate-100 transition-colors">{results.successRate.toFixed(1)}%</span>
                <span className={`text-xs font-bold flex items-center gap-1 mt-1 ${results.successRate > 90 ? 'text-emerald-600 dark:text-emerald-500' : results.successRate > 75 ? 'text-amber-600 dark:text-amber-500' : 'text-red-600 dark:text-red-500'}`}>
                  <span className="material-symbols-outlined text-xs">trending_up</span> {results.successRate > 90 ? 'High Confidence' : results.successRate > 75 ? 'Monitor Closely' : 'At Risk'}
                </span>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 leading-tight">Percentage of the 100,000 simulations where the portfolio balance never fell to $1 or below at any point during the {inputs.timeHorizon}-year period &mdash; not just at the end. A single year of depletion counts as failure even if later income temporarily restored the balance.</p>
              </div>
              <div className="bg-white dark:bg-slate-900 p-8 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-2 hover:shadow-md transition-all duration-300">
                <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">P{inputs.percentileAverage} Final Portfolio Value</span>
                <span className="text-2xl font-bold text-average-blue dark:text-blue-400 transition-colors">{formatCurrency(results.finalMedianValue)}</span>
                <span className="text-xs text-slate-400 dark:text-slate-500 mt-1">Real dollars (today's purchasing power) &mdash; inflation-adjusted.</span>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 leading-tight">The projected portfolio value in {startYear + inputs.timeHorizon} for the representative P{inputs.percentileAverage} simulation run (the single run whose year-by-year trajectory most closely matches the green P{inputs.percentileAverage} percentile curve). Expressed in today's purchasing power.</p>
              </div>
              <div className="bg-white dark:bg-slate-900 p-8 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-2 hover:shadow-md transition-all duration-300">
                <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Projected Volatility</span>
                <span className="text-2xl font-bold text-slate-900 dark:text-slate-100 transition-colors">{results.volatility.toFixed(1)}%</span>
                <span className="text-xs text-amber-600 dark:text-amber-500 font-bold mt-1">Annualized</span>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 leading-tight">Annualized standard deviation of portfolio returns across all 100,000 simulations. A higher number means wider year-to-year swings. For context, the S&amp;P 500's long-run volatility is ~17%.</p>
              </div>
              <div className="bg-white dark:bg-slate-900 p-8 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-2 hover:shadow-md transition-all duration-300">
                <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Initial Spend Rate</span>
                <span className="text-2xl font-bold text-slate-900 dark:text-slate-100 transition-colors">{((inputs.spendingPhases[0].annualSpend / (inputs.initialCash + inputs.initialInvestments)) * 100).toFixed(2)}%</span>
                <span className="text-xs text-slate-400 dark:text-slate-500 mt-1">Pre-tax, pre-SS, before G-K guardrail adjustments</span>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mt-2 leading-tight">First-year spending &divide; total portfolio, both in today's dollars. Social Security income and Guyton-Klinger guardrails will shift your effective withdrawal rate each year. Target benchmark for a 30-year horizon: 3.5&ndash;4.5%.</p>
              </div>
            </div>

            {/* Model Assumptions Disclosure — for CPA / IRS reviewer transparency.
                All parameters listed here are fixed research-based constants baked
                into the Monte Carlo engine. They are NOT user-configurable inputs. */}
            <details open className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm mt-5">
              <summary className="px-6 py-4 cursor-pointer flex items-center gap-2 text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider select-none hover:text-slate-700 dark:hover:text-slate-200 transition-colors list-none">
                <span className="material-symbols-outlined text-sm leading-none">info</span>
                Model Assumptions (CPA / IRS Review)
                <span className="material-symbols-outlined text-sm leading-none ml-auto">expand_more</span>
              </summary>
              <div className="px-6 pb-5 pt-2 border-t border-slate-100 dark:border-slate-800">
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mb-3 leading-relaxed">
                  The following parameters are calibrated from peer-reviewed financial research and IRS publications.
                  They are not exposed as user inputs to prevent inappropriate miscalibration.
                </p>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-8 gap-y-3 text-xs">
                  {([
                    { label: 'Inflation Volatility', value: '1.5% std dev', note: `Annual fluctuation jumping up or down around your expected average of ${inputs.inflationRate}%` },
                    { label: 'Market Relationships', value: '\u22120.30 Correlation', note: 'When stocks have a bad year, inflation tends to be slightly lower (e.g., during recessions). The simulation models this with a \u22120.30 correlation between stock returns and inflation draws.' },
                    { label: 'Market Crash Probability', value: '2% / year', note: `A black-swan event; about ${(100 * (1 - Math.pow(0.98, inputs.timeHorizon))).toFixed(0)}% chance of occurring at least once over your ${inputs.timeHorizon}-year horizon` },
                    { label: 'Crash Severity', value: '20\u201340% drop', note: 'Suddenly slashes the value of stocks for that specific year on top of normal market swings' },
                    { label: 'Safety Guardrail (Guyton-Klinger)', value: 'Overspending \u2192 \u221210%', note: 'Cuts spending by 10% if your withdrawal rate rises above 120% of the starting rate (capped at max 15% cumulative reduction)' },
                    { label: 'Prosperity Guardrail (Guyton-Klinger)', value: 'Excess growth \u2192 +10%', note: 'Raises spending by 10% if your withdrawal rate falls below 80% of the starting rate (capped at max 25% cumulative raise)' },
                    { label: 'Rebalancing Limit', value: '\u00b15% of target mix', note: 'We only force a costly trade if your mix wanders too far off target' },
                    { label: 'Fees & Costs', value: `${inputs.managementFee}% Mgt + 0.05% Trade`, note: `Your ${inputs.managementFee}% yearly management fee plus 0.05% friction cost applied whenever selling or buying` },
                    { label: 'Required Distribution (RMD)', value: 'IRS Uniform Lifetime', note: 'Follows SECURE 2.0 / IRS Pub.\u00a0590-B: age 72 (born \u22641950), age 73 (born 1951\u20131959), age 75 (born \u22651960). The simulation uses your Birth Year to set the exact threshold.' },
                    { label: 'Simulations Run', value: '100,000', note: 'Mathematically stress tests every possible future path based on your exact start numbers' },
                    { label: 'Value Display', value: "Real (Today's $)", note: "Everything is shown in today's purchasing power so you understand true buying power" },
                    { label: 'Stock Math', value: 'Log-normal Engine', note: `Generates realistic random annual returns centered on your ${inputs.expectedStockReturn}% target, with year-to-year randomness matching the statistical shape of historical equity markets (log-normal, \u03c3=17%).` },
                  ] as { label: string; value: string; note: string }[]).map(({ label, value, note }) => (
                    <div key={label} className="flex flex-col gap-0.5">
                      <span className="text-[9px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wide">{label}</span>
                      <span className="font-bold text-slate-700 dark:text-slate-200">{value}</span>
                      <span className="text-[9px] text-slate-400 dark:text-slate-500 leading-tight">{note}</span>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          </div>
        </div>
      </main >
    </div >
  );
};

export default SimulationView;