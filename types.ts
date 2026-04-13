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
  managementFee: number;
  customStockAllocation: number; // 0 to 100
  // --- Tax & RMD (CPA-grade) ---
  currentAge: number;        // User's age at retirement start — drives RMD schedule
  taxDeferredRatio: number;  // 0–100: % of investable assets held in Traditional IRA / 401(k)
  withdrawalTaxRate: number; // Effective marginal rate (0–50%) applied to all withdrawals
  
  // --- Supplemental Income (Social Security / Pension) ---
  birthYear: number;
  socialSecurityIncome: number; // Monthly estimate (e.g. 1200)
  socialSecurityAge: number;    // Age to start claiming
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
  cashReturn: number; // New field for transparency
  growthAmount: number;
  feesAmount: number;
  action: string;
  withdrawal: number;
  endTotal: number;
  // --- CPA-grade additions ---
  rmdAmount: number;        // IRS-mandated minimum distribution for this year (0 if not applicable)
  nominalWithdrawal: number; // withdrawal expressed in nominal (future) dollars for 1099-R reference
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