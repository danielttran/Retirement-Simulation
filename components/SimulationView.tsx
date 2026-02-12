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
}

// Typed tooltip props
const CustomTooltip = ({ active, payload, label }: CustomTooltipProps) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-white border border-slate-200 p-4 rounded-xl shadow-xl min-w-[200px]">
        <div className="border-b border-slate-100 pb-2 mb-2">
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Forecast Year</p>
          <p className="text-sm font-bold text-slate-800">{label}</p>
        </div>
        <div className="space-y-1">
          {payload.map((entry, index) => (
            <div key={index} className="flex justify-between items-center gap-4">
              <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: entry.color }}>
                {entry.name}
              </span>
              <span className="text-xs font-bold text-slate-700">
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
}

const SimulationView: React.FC<SimulationViewProps> = ({
  inputs,
  results,
  selectedStrategy,
  setSelectedStrategy,
  onEdit,
  onRun,
  onCustomAllocationChange
}) => {
  const [viewDuration, setViewDuration] = useState<number | 'MAX'>('MAX');
  const [auditMode, setAuditMode] = useState(false);
  const [auditScenario, setAuditScenario] = useState<'AVERAGE' | 'BELOW' | 'DOWNTURN'>('BELOW');

  const startYear = new Date().getFullYear();
  const runTime = new Date(results.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const formatCurrency = (val: number) => {
    if (val >= 1000000) return `$${(val / 1000000).toFixed(1)}M`;
    if (val >= 1000) return `$${(val / 1000).toFixed(0)}k`;
    return `$${val}`;
  };

  const getStrategyName = (s: StrategyType) => {
    switch (s) {
      case 'BUCKET': return 'Bucket Strategy';
      case 'CONSERVATIVE': return '60/40 Split';
      case 'AGGRESSIVE': return '70/30 Split';
      case 'CUSTOM': return 'Custom Allocation';
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
            <li><strong>Cash Bucket:</strong> Holds 2 years of living expenses in safe, liquid assets.</li>
            <li><strong>Growth Bucket:</strong> The remainder is invested in equities for long-term growth.</li>
          </ul>
          <p className="mb-2 font-bold text-slate-700 text-[11px] uppercase tracking-wide">Rules of Operation:</p>
          <ol className="list-decimal pl-4 space-y-2">
            <li>If the market is <strong>UP</strong> (Stock Up), we sell gains to refill the Cash Bucket back to 2 years.</li>
            <li>If the market is <strong>DOWN</strong> (Stock Down), we <strong>do not sell stocks</strong>. We spend directly from the Cash Bucket, allowing stocks time to recover.</li>
            <li>Stocks are only sold in a downturn if the Cash Bucket is completely empty.</li>
          </ol>
        </>
      );
    } else {
      const stockPct = s === 'CONSERVATIVE' ? 60 : s === 'AGGRESSIVE' ? 70 : inputs.customStockAllocation;
      const bondPct = 100 - stockPct;
      return (
        <>
          <p className="mb-4">
            A traditional <strong>Fixed Allocation</strong> strategy that maintains a constant {stockPct}% Stock / {bondPct}% Bond ratio.
          </p>
          <p className="mb-2 font-bold text-slate-700 text-[11px] uppercase tracking-wide">Rules of Operation (Yearly Rebalancing):</p>
          <ul className="list-disc pl-4 space-y-2 mb-4">
            <li>
              <strong>If Stock is UP:</strong> The portfolio has too much stock. We sell some stock to refill our bonds and pay expenses.
            </li>
            <li>
              <strong>If Stock is DOWN:</strong> The portfolio has too many bonds. We spend from the bonds (selling them) to pay expenses and buy cheap stocks to restore the ratio.
            </li>
          </ul>
          <p>
            This disciplined approach automatically forces you to buy low and sell high while ensuring you always have the target mix of safety (bonds) and growth (stocks).
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
    const headers = ['Year', 'Average Market', 'Below Average', 'Significant Downturn'];
    const rows = results.data.map(d => [
      d.year,
      d.average ? d.average.toFixed(2) : '0.00',
      d.belowAverage ? d.belowAverage.toFixed(2) : '0.00',
      d.downturn ? d.downturn.toFixed(2) : '0.00'
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
      // Average
      if (d.average <= 0) {
        newD.average = avgDepleted ? null : 0;
        avgDepleted = true;
      } else { avgDepleted = false; }

      // Below Average
      if (d.belowAverage <= 0) {
        newD.belowAverage = belowDepleted ? null : 0;
        belowDepleted = true;
      } else { belowDepleted = false; }

      // Downturn
      if (d.downturn <= 0) {
        newD.downturn = downDepleted ? null : 0;
        downDepleted = true;
      } else { downDepleted = false; }

      return newD;
    });

  }, [results.data, viewDuration, startYear]);

  return (
    <div className="min-h-screen bg-background-light text-slate-800 animate-fade-in">
      {/* Navbar */}
      <nav className="bg-white border-b border-slate-200 sticky top-0 z-50">
        <div className="max-w-[1440px] mx-auto px-6 md:px-10 h-20 flex items-center justify-between">
          <div className="flex items-center gap-5">
            <div className="w-10 h-10 bg-primary flex items-center justify-center rounded-xl shadow-sm cursor-pointer hover:bg-yellow-400 transition-colors" onClick={onEdit}>
              <span className="material-symbols-outlined text-slate-900 text-2xl font-bold">query_stats</span>
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight text-slate-900 hidden md:block">Retirement Simulation Analysis</h1>
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Monte Carlo Engine</p>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="hidden md:flex items-center gap-3 px-5 py-2 bg-slate-50 rounded-full border border-slate-200">
              <span className="text-[11px] text-slate-400 font-semibold uppercase tracking-wider">Success Rate</span>
              <span className={`text-xs font-bold ${results.successRate > 90 ? 'text-emerald-600' : results.successRate > 75 ? 'text-amber-600' : 'text-red-600'}`}>
                {results.successRate.toFixed(1)}% ({results.successRate > 90 ? 'High' : 'Moderate'})
              </span>
            </div>
            <button
              onClick={handleExportReport}
              aria-label="Export simulation report"
              className="bg-emerald-900 text-white px-6 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider hover:bg-emerald-800 transition-all flex items-center gap-2 shadow-md cursor-pointer"
            >
              <span className="material-symbols-outlined text-lg">download_for_offline</span>
              <span className="hidden md:inline">Export Report</span>
            </button>
          </div>
        </div>
      </nav>

      {/* Sub-header Inputs Summary */}
      <div className="bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-[1440px] mx-auto px-6 md:px-10 py-4 flex items-center justify-between overflow-x-auto gap-8 no-scrollbar">
          <div className="flex items-center gap-10 shrink-0">
            <div className="flex flex-col">
              <span className="text-[11px] uppercase font-semibold text-slate-400 tracking-wider">Total Portfolio</span>
              <span className="text-sm font-bold text-slate-800">${(inputs.initialCash + inputs.initialInvestments).toLocaleString()}</span>
            </div>
            <div className="w-px h-8 bg-slate-200"></div>
            <div className="flex flex-col">
              <span className="text-[11px] uppercase font-semibold text-slate-400 tracking-wider">Annual Spend (Today's $)</span>
              <span className="text-sm font-bold text-slate-800">${inputs.annualSpend.toLocaleString()}</span>
            </div>
            <div className="w-px h-8 bg-slate-200"></div>
            <div className="flex flex-col">
              <span className="text-[11px] uppercase font-semibold text-slate-400 tracking-wider">Start Year</span>
              <span className="text-sm font-bold text-slate-800">{startYear}</span>
            </div>
            <div className="w-px h-8 bg-slate-200"></div>
            <div className="flex flex-col">
              <span className="text-[11px] uppercase font-semibold text-slate-400 tracking-wider">Time Horizon</span>
              <span className="text-sm font-bold text-slate-800">{inputs.timeHorizon} Years</span>
            </div>
          </div>
          <button
            onClick={onEdit}
            aria-label="Adjust simulation inputs"
            className="flex items-center gap-2 text-xs font-bold text-white hover:text-white px-5 py-2.5 bg-emerald-900 hover:bg-emerald-800 rounded-lg shadow-md transition-all whitespace-nowrap cursor-pointer uppercase tracking-wider"
          >
            <span className="material-symbols-outlined text-sm leading-none">settings_input_component</span>
            Adjust Inputs
          </button>
        </div>
      </div>

      <main className="max-w-[1440px] mx-auto px-6 md:px-10 py-10">
        {/* Strategy Tabs */}
        <div className="mb-10 border-b border-slate-200 overflow-x-auto">
          <div className="flex gap-8 md:gap-12 min-w-max" role="tablist" aria-label="Investment strategies">
            {(['BUCKET', 'CONSERVATIVE', 'AGGRESSIVE', 'CUSTOM'] as StrategyType[]).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={selectedStrategy === t}
                onClick={() => handleStrategyChange(t)}
                className={`pb-5 text-sm font-medium transition-all border-b-2 ${selectedStrategy === t
                  ? 'text-slate-900 border-primary font-bold'
                  : 'text-slate-400 hover:text-slate-600 border-transparent'
                  }`}
              >
                {t === 'BUCKET' && 'Bucket Strategy'}
                {t === 'CONSERVATIVE' && '60/40 Split'}
                {t === 'AGGRESSIVE' && '70/30 Split'}
                {t === 'CUSTOM' && (
                  <span className="flex items-center gap-2">
                    Custom Allocation
                    {selectedStrategy === 'CUSTOM' && <span className="bg-primary/20 text-slate-800 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-tighter">Live</span>}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-12 gap-10">
          <div className="col-span-12 lg:col-span-9">

            {/* Chart Container */}
            <div className="bg-white border border-slate-200 rounded-xl p-6 md:p-10 shadow-sm mb-10">
              <div className="flex flex-col md:flex-row md:items-end justify-between mb-8 gap-6">
                <div>
                  <h2 className="text-lg font-bold text-slate-900 mb-1">Portfolio Projection</h2>
                  <p className="text-xs text-slate-500 font-medium">10,000 market scenarios simulated <span className="text-slate-300 mx-2">•</span> Last Run: {runTime}</p>
                </div>

                <div className="flex flex-col md:items-end gap-4">
                  {/* Time Horizon Buttons */}
                  <div className="bg-slate-50 p-1 rounded-lg border border-slate-200 flex flex-wrap gap-1">
                    {[5, 10, 15, 20].map(year => (
                      <button
                        key={year}
                        onClick={() => setViewDuration(year)}
                        className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${viewDuration === year
                          ? 'bg-white text-slate-900 shadow-sm border border-slate-100'
                          : 'text-slate-500 hover:text-slate-900'
                          }`}
                      >
                        {year} Years
                      </button>
                    ))}
                    <button
                      onClick={() => setViewDuration('MAX')}
                      className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${viewDuration === 'MAX'
                        ? 'bg-white text-slate-900 shadow-sm border border-slate-100'
                        : 'text-slate-500 hover:text-slate-900'
                        }`}
                    >
                      Full View
                    </button>
                  </div>

                  {/* Legend */}
                  <div className="flex flex-wrap items-center gap-4 md:gap-6">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-growth-green"></span>
                      <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Average Market</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-below-avg-gold"></span>
                      <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Below Average</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-downturn-red"></span>
                      <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Significant Downturn</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Custom Allocation Slider */}
              {selectedStrategy === 'CUSTOM' && (
                <div className="mb-8 p-6 bg-slate-50 border border-slate-200 rounded-xl animate-in fade-in slide-in-from-top-2">
                  <div className="flex justify-between items-center mb-4">
                    <label className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                      Stock / Bond Allocation
                    </label>
                    <span className="text-sm font-bold bg-white px-3 py-1 rounded border border-slate-200 shadow-sm">
                      {inputs.customStockAllocation}% Stocks / {100 - inputs.customStockAllocation}% Bonds
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-xs font-bold text-slate-400 w-16 text-right">0% Equity</span>
                    <input
                      className="w-full h-2 bg-slate-200 accent-primary rounded-lg appearance-none cursor-pointer"
                      max="100" min="0" step="5"
                      type="range"
                      value={inputs.customStockAllocation}
                      onChange={handleCustomSliderChange}
                    />
                    <span className="text-xs font-bold text-slate-400 w-16">100% Equity</span>
                  </div>
                </div>
              )}

              {/* Chart Area */}
              <div className="relative h-[400px] md:h-[500px] w-full rounded-xl border border-slate-100 bg-slate-50/20 p-2">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={visibleData} margin={{ top: 20, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorAvg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#059669" stopOpacity={0.1} />
                        <stop offset="95%" stopColor="#059669" stopOpacity={0} />
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
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis
                      dataKey="year"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: '#94a3b8', fontSize: 11, fontWeight: 'bold' }}
                      dy={10}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: '#94a3b8', fontSize: 11, fontWeight: 'bold' }}
                      tickFormatter={formatCurrency}
                      dx={-10}
                    />
                    <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#cbd5e1', strokeWidth: 1, strokeDasharray: '5 5' }} />
                    <Area
                      type="monotone"
                      dataKey="average"
                      name="Average Market"
                      stroke="#059669"
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
                      name="Significant Downturn"
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
              <div className="mt-8 p-6 bg-blue-50/50 rounded-xl border border-blue-100">
                <h4 className="text-xs font-bold text-slate-900 mb-2 flex items-center gap-2">
                  <span className="material-symbols-outlined text-lg text-blue-600">help</span>
                  How to read this chart
                </h4>
                <div className="p-6 bg-slate-50 border-t border-slate-100 grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div>
                    <span className="block font-bold text-growth-green text-xs mb-1">Average Market (Green)</span>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      Represents the median outcome (50th percentile). In 50% of historical scenarios, your portfolio performed better than this line. This is a realistic target for "normal" market conditions.
                    </p>
                  </div>
                  <div>
                    <span className="block font-bold text-below-avg-gold text-xs mb-1">Below Average (Gold)</span>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      The 25th percentile outcome. This line shows a sluggish market environment where growth is consistently lower than historical averages. Good for conservative planning.
                    </p>
                  </div>
                  <div>
                    <span className="block font-bold text-downturn-red text-xs mb-1">Significant Downturn (Red)</span>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      The 10th percentile "stress test". This simulates a prolonged recession or poor sequence of returns. If this line stays above $0, your plan is highly resilient.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Detailed Data Table */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden mb-10">
              <div className="p-6 border-b border-slate-100 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div className="flex items-center gap-4">
                  <h3 className="text-base font-bold text-slate-900 whitespace-nowrap">
                    {auditMode ? 'Audit Strategy Log' : 'Yearly Balance Projection'}
                  </h3>
                  {/* Checkbox Button */}
                  <label className="flex items-center gap-3 cursor-pointer select-none group ml-4">
                    <div className={`w-5 h-5 rounded border flex items-center justify-center transition-all ${auditMode ? 'bg-primary border-primary' : 'bg-white border-slate-300 group-hover:border-primary'}`}>
                      <span className={`material-symbols-outlined text-[14px] font-bold text-slate-900 transition-opacity ${auditMode ? 'opacity-100' : 'opacity-0'}`}>check</span>
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
                  {!auditMode && <span className="text-[11px] text-slate-400 font-semibold uppercase hidden md:inline tracking-wider">Last Updated: {runTime}</span>}
                  {auditMode && (
                    <div className="flex bg-slate-100 p-1 rounded-lg">
                      <button
                        onClick={() => setAuditScenario('AVERAGE')}
                        className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${auditScenario === 'AVERAGE' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                      >
                        Average Market
                      </button>
                      <button
                        onClick={() => setAuditScenario('BELOW')}
                        className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${auditScenario === 'BELOW' ? 'bg-white text-amber-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                      >
                        Below Average
                      </button>
                      <button
                        onClick={() => setAuditScenario('DOWNTURN')}
                        className={`px-3 py-1 text-[11px] font-bold uppercase tracking-wider rounded-md transition-all ${auditScenario === 'DOWNTURN' ? 'bg-white text-red-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                      >
                        Significant Downturn
                      </button>
                    </div>
                  )}
                  <button
                    onClick={handleDownloadCSV}
                    className="flex items-center gap-2 text-xs font-bold text-white hover:text-white px-4 py-2 bg-emerald-900 hover:bg-emerald-800 rounded-lg shadow-md transition-all whitespace-nowrap cursor-pointer uppercase tracking-wider"
                  >
                    <span>Download CSV</span>
                    <span className="material-symbols-outlined text-sm leading-none">download</span>
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto max-h-[600px] custom-scrollbar">
                <table className="w-full text-sm text-left relative">
                  {auditMode ? (
                    // AUDIT TABLE HEADERS
                    <thead className="bg-slate-50 text-xs text-slate-500 uppercase font-bold tracking-wider sticky top-0 z-10 shadow-sm">
                      <tr>
                        <th className="px-4 py-4 bg-slate-50 text-slate-800">Year</th>
                        <th className="px-4 py-4 bg-slate-50 text-slate-800">Start Balance</th>
                        <th className="px-4 py-4 bg-slate-50 text-slate-800">Real Returns</th>
                        <th className="px-4 py-4 bg-slate-50 text-slate-800">Growth</th>
                        <th className="px-4 py-4 bg-slate-50 text-amber-600">Fees</th>
                        <th className="px-4 py-4 bg-slate-50 text-slate-800 w-1/4">Strategy Action</th>
                        <th className="px-4 py-4 bg-slate-50 text-slate-800">Withdrawal</th>
                        <th className="px-4 py-4 bg-slate-50 text-slate-800">End Balance</th>
                      </tr>
                    </thead>
                  ) : (
                    // NORMAL TABLE HEADERS
                    <thead className="bg-slate-50 text-xs text-slate-500 uppercase font-bold tracking-wider sticky top-0 z-10 shadow-sm">
                      <tr>
                        <th className="px-6 py-4 bg-slate-50">Year</th>
                        <th className="px-6 py-4 bg-slate-50 text-growth-green">Average Market</th>
                        <th className="px-6 py-4 bg-slate-50 text-below-avg-gold">Below Average</th>
                        <th className="px-6 py-4 bg-slate-50 text-downturn-red">Significant Downturn</th>
                      </tr>
                    </thead>
                  )}

                  <tbody className="divide-y divide-slate-100">
                    {auditMode ? (
                      // AUDIT TABLE ROWS
                      getAuditData().map((row) => (
                        <tr key={row.year} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-4 py-4 font-bold text-slate-700">{row.year}</td>
                          <td className="px-4 py-4 font-medium text-slate-600 text-xs">
                            <div>${(row.startCash + row.startStock + row.startBond).toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
                          </td>
                          <td className="px-4 py-4 text-xs font-medium">
                            <div className={`${row.stockReturn >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>Stock: {(row.stockReturn * 100).toFixed(1)}%</div>
                            {/* Only show Bond if strategy is NOT Bucket (which has 0 bonds) */}
                            {selectedStrategy !== 'BUCKET' && (
                              <div className={`${row.bondReturn >= 0 ? 'text-blue-600' : 'text-red-600'}`}>Bond: {(row.bondReturn * 100).toFixed(1)}%</div>
                            )}
                            {/* Only show Cash if strategy IS Bucket (Fixed allocations have 0 cash) */}
                            {selectedStrategy === 'BUCKET' && (
                              <div className="text-slate-400">Cash: {(row.cashReturn * 100).toFixed(1)}%</div>
                            )}
                          </td>
                          <td className={`px-4 py-4 font-bold ${row.growthAmount >= 0 ? 'text-emerald-600' : 'text-downturn-red'}`}>
                            {row.growthAmount >= 0 ? '+' : ''}${row.growthAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                          <td className="px-4 py-4 font-bold text-amber-600">
                            -${row.feesAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                          <td className="px-4 py-4 text-xs font-medium text-slate-700 leading-relaxed">
                            {row.action}
                          </td>
                          <td className="px-4 py-4 font-medium text-slate-600">
                            -${row.withdrawal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                          <td className="px-4 py-4 font-bold text-slate-800">
                            ${row.endTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                        </tr>
                      ))
                    ) : (
                      // NORMAL TABLE ROWS
                      visibleData.map((row) => (
                        <tr key={row.year} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-6 py-4 font-bold text-slate-700">
                            {row.year}
                            {row.year - startYear > 0 && <span className="text-[10px] text-slate-400 font-normal ml-1">({row.year - startYear} years away)</span>}
                          </td>
                          <td className={`px-6 py-4 font-medium ${row.average === null ? 'bg-red-50 text-red-600' : 'text-slate-600'}`}>
                            {row.average !== null ? `$${row.average.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'Depleted'}
                          </td>
                          <td className={`px-6 py-4 font-medium ${row.belowAverage === null ? 'bg-orange-50 text-orange-600' : 'text-slate-600'}`}>
                            {row.belowAverage !== null ? `$${row.belowAverage.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : 'Depleted'}
                          </td>
                          <td className={`px-6 py-4 font-medium ${row.downturn === null ? 'bg-red-100 text-red-700' : 'text-slate-600'}`}>
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
              <div className="bg-white p-8 rounded-xl border border-slate-200 shadow-sm flex flex-col gap-2 hover:shadow-md transition-shadow">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Success Probability</span>
                <span className="text-2xl font-bold text-slate-900">{results.successRate.toFixed(1)}%</span>
                <span className={`text-xs font-bold flex items-center gap-1 mt-1 ${results.successRate > 90 ? 'text-emerald-600' : 'text-amber-600'}`}>
                  <span className="material-symbols-outlined text-xs">trending_up</span> {results.successRate > 90 ? 'High Confidence' : 'Monitor Closely'}
                </span>
                <p className="text-[10px] text-slate-400 mt-2 leading-tight">Percentage of simulations where portfolio &gt; $0 at end of term.</p>
              </div>
              <div className="bg-white p-8 rounded-xl border border-slate-200 shadow-sm flex flex-col gap-2 hover:shadow-md transition-shadow">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Expected Final Value</span>
                <span className="text-2xl font-bold text-average-blue">{formatCurrency(results.finalMedianValue)}</span>
                <span className="text-xs text-slate-400 mt-1">Real Dollars (Today's Purchasing Power)</span>
                <p className="text-[10px] text-slate-400 mt-2 leading-tight">The median projected purchasing power in {startYear + inputs.timeHorizon}. Adjusted for inflation.</p>
              </div>
              <div className="bg-white p-8 rounded-xl border border-slate-200 shadow-sm flex flex-col gap-2 hover:shadow-md transition-shadow">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Projected Volatility</span>
                <span className="text-2xl font-bold text-slate-900">{results.volatility.toFixed(1)}%</span>
                <span className="text-xs text-amber-600 font-bold mt-1">Annualized</span>
                <p className="text-[10px] text-slate-400 mt-2 leading-tight">Typical annual swing in portfolio value based on this strategy.</p>
              </div>
              <div className="bg-white p-8 rounded-xl border border-slate-200 shadow-sm flex flex-col gap-2 hover:shadow-md transition-shadow">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Starting Safe Withdrawal</span>
                <span className="text-2xl font-bold text-slate-900">{((inputs.annualSpend / (inputs.initialCash + inputs.initialInvestments)) * 100).toFixed(2)}%</span>
                <span className="text-xs text-slate-400 mt-1">Initial Rate</span>
                <p className="text-[10px] text-slate-400 mt-2 leading-tight">Recommended safe rate is typically 3.5% - 4.0%.</p>
              </div>
            </div>
          </div>

          {/* Sidebar Insights */}
          <aside className="col-span-12 lg:col-span-3 space-y-8">
            <div className="bg-white border border-slate-200 rounded-xl p-8 shadow-sm relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary/10 rounded-full -mr-16 -mt-16"></div>
              <div className="relative">
                <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-6 flex items-center gap-2">
                  <span className="material-symbols-outlined text-lg text-primary">info</span>
                  Strategy Insight
                </h3>
                <div className="space-y-6 text-xs leading-relaxed text-slate-500 font-medium">
                  {getStrategyDescription(selectedStrategy)}
                  <div className="space-y-4 pt-2">
                    <h4 className="text-[11px] font-bold text-slate-900 uppercase tracking-wider">Active Weights (Target)</h4>
                    <div className="space-y-4">
                      <div>
                        <div className="flex justify-between items-center text-[11px] mb-2">
                          <span className="text-slate-500 font-bold">Liquid / Cash</span>
                          <span className="font-bold text-slate-900">{(results.allocation.cash * 100).toFixed(1)}%</span>
                        </div>
                        <div className="w-full bg-slate-100 h-1.5 rounded-full">
                          <div className="bg-primary h-full rounded-full" style={{ width: `${results.allocation.cash * 100}%` }}></div>
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between items-center text-[11px] mb-2">
                          <span className="text-slate-500 font-bold">Bonds</span>
                          <span className="font-bold text-slate-900">{(results.allocation.bond * 100).toFixed(1)}%</span>
                        </div>
                        <div className="w-full bg-slate-100 h-1.5 rounded-full">
                          <div className="bg-slate-500 h-full rounded-full" style={{ width: `${results.allocation.bond * 100}%` }}></div>
                        </div>
                      </div>
                      <div>
                        <div className="flex justify-between items-center text-[11px] mb-2">
                          <span className="text-slate-500 font-bold">Equities</span>
                          <span className="font-bold text-slate-900">{(results.allocation.stock * 100).toFixed(1)}%</span>
                        </div>
                        <div className="w-full bg-slate-100 h-1.5 rounded-full">
                          <div className="bg-slate-900 h-full rounded-full" style={{ width: `${results.allocation.stock * 100}%` }}></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-6 text-center shadow-sm">
              <p className="text-[11px] font-semibold text-primary uppercase mb-2 tracking-wider">Simulation Core</p>
              <p className="text-xs text-slate-500 mb-6 leading-relaxed">Parametric model calibrated to long-term historical averages for variance modeling.</p>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
};

export default SimulationView;