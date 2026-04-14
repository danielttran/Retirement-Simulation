export interface SpendingPhase {
  id: number;          // stable React key; increment on creation
  startYear: number;   // 0-based, inclusive — phase covers [startYear, endYear)
  endYear: number;     // 0-based, exclusive
  annualSpend: number; // nominal dollars (today's $)
}

export interface SimulationInputs {
  initialCash: number;
  initialInvestments: number;
  spendingPhases: SpendingPhase[]; // replaces annualSpend; covers [0, timeHorizon) contiguously
  timeHorizon: number;
  inflationRate: number;
  expectedStockReturn: number;
  managementFee: number;
  customStockAllocation: number; // 0 to 100
  // --- Tax & RMD (CPA-grade) ---
  currentAge: number;        // User's age at retirement start — drives RMD schedule
  taxDeferredRatio: number;  // 0–100: % of investable assets held in Traditional IRA / 401(k)
  withdrawalTaxRate: number; // Effective marginal rate (0–60%) applied to pre-tax account withdrawals
  
  // --- Supplemental Income (Social Security / Pension) ---
  birthYear: number;
  socialSecurityIncome: number; // Monthly estimate (e.g. 1200)
  socialSecurityAge: number;    // Age to start claiming

  // --- Scenario Band Percentiles ---
  // Define which Monte Carlo percentile each of the three chart lines represents.
  // Defaults: 50 (median) / 25 (below-avg) / 10 (stress test).
  percentileAverage: number;       // 1–99, shown as the green "Average Market" line
  percentileBelowAverage: number;  // 1–99, shown as the gold "Below Average" line
  percentileDownturn: number;      // 1–99, shown as the red "Downturn" line
}

export type StrategyType = 'BUCKET' | 'CONSERVATIVE' | 'AGGRESSIVE' | 'CUSTOM';

export interface YearResult {
  year: number;
  // null signals portfolio depletion; Recharts renders a gap when connectNulls={false}.
  average: number | null;
  belowAverage: number | null;
  downturn: number | null;
}

export interface AuditRow {
  year: number;
  startCash: number;
  startStock: number;
  startBond: number;
  stockReturn: number;
  bondReturn: number;
  cashReturn: number;
  /** Stochastic inflation realised this year (varies from user's mean due to random draw). */
  realizedInflation: number;
  growthAmount: number;
  feesAmount: number;
  /** Mechanical strategy action only — rebalance, bucket refill, etc. No G-K text. */
  action: string;
  /** Isolated Guyton-Klinger guardrail event string; empty string when no trigger fired. */
  gkEvent: string;
  withdrawal: number;
  taxPaid: number;
  endTotal: number;
  // --- CPA-grade additions ---
  rmdAmount: number;         // IRS-mandated minimum distribution for this year (0 if not applicable)
  /** Withdrawal in nominal (future) dollars using cumulative stochastic inflation — for 1099-R reference. */
  nominalWithdrawal: number;
  ssIncome: number;          // Annual SS / pension income applied this year (0 before claiming age)
  /** Accumulated Guyton-Klinger spend-adjustment factor at end of this year (1.0 = no adjustment). */
  spendMultiplier: number;
  /** True when a jump-diffusion (Merton) crash event fired this year (2 % annual probability). */
  crashed: boolean;
}

export interface SimulationResult {
  data: YearResult[];
  auditLogAverage: AuditRow[];
  auditLogBelowAverage: AuditRow[];
  auditLogDownturn: AuditRow[];
  successRate: number; // Percentage of runs that didn't deplete
  finalMedianValue: number;
  volatility: number;
  allocation: {
    stock: number;
    bond: number;
    cash: number;
  };
  timestamp: number;
}

export interface ScenarioConfig {
  label: string;
  type: StrategyType;
  description: string;
}