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
  expectedBondReturn: number;   // nominal %, e.g. 4.0
  expectedCashReturn: number;   // nominal %, e.g. 2.5
  expectedStockVolatility: number;  // nominal %, e.g. 17.0
  managementFee: number;
  customStockAllocation: number; // 0 to 100
  customCashAllocation: number;  // 0 to 100; bond = 100 - stock - cash
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

  // --- Early Retirement: SEPP / IRS Rule 72(t) ---
  /** % of investable assets in Roth IRA / Roth 401(k). taxDeferredRatio + rothRatio
   *  must be ≤ 100; remainder is taxable brokerage. SEPP applies to Traditional + Roth
   *  combined; Roth contributions are penalty-free even outside SEPP. */
  rothRatio: number;
  /** Simulate IRS Rule 72(t) Substantially Equal Periodic Payments — penalty-free
   *  withdrawals from retirement accounts before age 59½ up to a computed cap. */
  useSEPP: boolean;
  /** Interest rate for the Fixed-Amortization SEPP formula. IRS caps at 120% of
   *  the federal mid-term AFR; ~5.0% is a current proxy. */
  seppRate: number;
  /** Auto-add inflation-adjusted healthcare expenses: ~$8k/yr pre-65 (Medicare gap),
   *  ~$7k/yr post-65 (Medicare + supplemental), inflated at medical CPI ~5.5%. */
  includeHealthcare: boolean;
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
  /** Annual SEPP cap (Rule 72(t) Fixed-Amortization). 0 if SEPP inactive this year. */
  seppCap: number;
  /** Penalty paid this year for early-withdrawal violations (10% of taxable overage
   *  before age 59½ when SEPP is not used or its cap is breached). */
  earlyPenalty: number;
  /** Healthcare expense added to baseSpend this year (today's $) when includeHealthcare. */
  healthcareSpend: number;
}

export interface SimulationResult {
  data: YearResult[];
  auditLogAverage: AuditRow[];
  auditLogBelowAverage: AuditRow[];
  auditLogDownturn: AuditRow[];
  /** Zero-Touch Rate: % of runs where the portfolio NEVER touched $1 or below at any point during the horizon. */
  successRate: number;
  /** Comfortable Survival Rate: % of runs where the portfolio ended with ≥ 25% of the strategy-adjusted starting real portfolio value. Lower than successRate — separates "survived but depleted" from "ended with meaningful reserves". */
  comfortableSurvivalRate: number;
  /** Strategy-adjusted comfort floor used for terminalSuccessRate (25% of post-setup starting balance, real dollars). */
  comfortFloorValue: number;
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
