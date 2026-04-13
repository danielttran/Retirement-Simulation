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
}

export type StrategyType = 'BUCKET' | 'CONSERVATIVE' | 'AGGRESSIVE' | 'CUSTOM';

export interface YearResult {
  year: number;
  average: number;
  belowAverage: number;
  downturn: number;
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