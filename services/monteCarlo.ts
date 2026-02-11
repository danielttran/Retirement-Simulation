import { SimulationInputs, SimulationResult, StrategyType, YearResult, AuditRow } from '../types';

// 1. CONFIGURATION & CONSTANTS

const TRANSACTION_COST = 0.0005; // 0.05% friction on selling/rebalancing

// Nominal Return Assumptions (Long-term historical averages)
const NOMINAL_ASSUMPTIONS = {
  STOCK: { mean: 0.085, stdDev: 0.17 }, // ~8.5% Nominal, 17% Vol
  BOND:  { mean: 0.040, stdDev: 0.05 }, // ~4.0% Nominal, 5% Vol
  CASH:  { mean: 0.025, stdDev: 0.015 }, // ~2.5% Nominal, 1.5% Vol
};

// Correlation Matrix (Stocks, Bonds, Cash)
const CORRELATION_MATRIX = [
  [1.00, -0.15, 0.05],  // Stock-Stock, Stock-Bond, Stock-Cash
  [-0.15, 1.00, 0.15],  // Bond-Stock, Bond-Bond, Bond-Cash
  [0.05, 0.15, 1.00],   // Cash-Stock, Cash-Bond, Cash-Cash
];

const NUM_SIMULATIONS = 10000; 

// 2. MATHEMATICAL HELPERS

function randn_bm() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Cholesky Decomposition
function choleskyDecompose(matrix: number[][]): number[][] {
  const n = matrix.length;
  const L = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      L[i][j] = i === j
        ? Math.sqrt(matrix[i][i] - sum)
        : (matrix[i][j] - sum) / L[j][j];
    }
  }
  return L;
}

const CHOL_L = choleskyDecompose(CORRELATION_MATRIX);

/**
 * Generates correlated log-normal returns
 */
function generateAnnualReturns(realAssumptions: typeof NOMINAL_ASSUMPTIONS) {
  const Z = [randn_bm(), randn_bm(), randn_bm()];

  const Z_corr = [
    CHOL_L[0][0] * Z[0],
    CHOL_L[1][0] * Z[0] + CHOL_L[1][1] * Z[1],
    CHOL_L[2][0] * Z[0] + CHOL_L[2][1] * Z[1] + CHOL_L[2][2] * Z[2]
  ];

  const getLogParams = (arithMean: number, arithStd: number) => {
    // CLAMPING FIX: Ensure term is positive to avoid NaN on high inflation
    const term = Math.max(1 + arithMean, 0.0001);
    const phi = Math.sqrt((arithStd * arithStd) + (term * term));
    const mu_log = Math.log(term * term / phi);
    const sigma_log = Math.sqrt(Math.log(phi * phi / (term * term)));
    return { mu_log, sigma_log };
  };

  const sParams = getLogParams(realAssumptions.STOCK.mean, realAssumptions.STOCK.stdDev);
  const bParams = getLogParams(realAssumptions.BOND.mean, realAssumptions.BOND.stdDev);
  const cParams = getLogParams(realAssumptions.CASH.mean, realAssumptions.CASH.stdDev);

  return {
    stock: Math.exp(sParams.mu_log + sParams.sigma_log * Z_corr[0]) - 1,
    bond:  Math.exp(bParams.mu_log + bParams.sigma_log * Z_corr[1]) - 1,
    cash:  Math.exp(cParams.mu_log + cParams.sigma_log * Z_corr[2]) - 1,
  };
}

// 3. SIMULATION LOGIC

interface SimulationRun {
  id: number;
  finalBalance: number;
  trajectory: Float64Array; // Memory Optimization
  annualReturns: { stock: number; bond: number; cash: number }[];
  portfolioReturns: number[]; 
}

interface SimState {
  stock: number;
  bond: number;
  cash: number;
  spend: number;
}

interface YearOutcome {
  nextState: SimState;
  withdrawal: number;
  fees: number;
  growth: number;
  actionLog: string;
}

const simulateYear = (
  state: SimState,
  returns: { stock: number, bond: number, cash: number },
  inputs: SimulationInputs,
  strategy: StrategyType,
  targetWeights: { stock: number, bond: number }
): YearOutcome => {
  const { managementFee } = inputs;
  const isBucketStrategy = strategy === 'BUCKET';
  
  // 1. Apply Market Returns
  const grossStock = state.stock * (1 + returns.stock);
  const grossBond = state.bond * (1 + returns.bond);
  const grossCash = state.cash * (1 + returns.cash);
  
  const growth = (grossStock - state.stock) + (grossBond - state.bond) + (grossCash - state.cash);

  // 2. Apply Management Fees (Standardized: Deduct from invested assets before withdrawal)
  const feeRate = managementFee / 100;
  const stockFee = grossStock * feeRate;
  const bondFee = grossBond * feeRate;
  
  let currStock = grossStock - stockFee;
  let currBond = grossBond - bondFee;
  let currCash = grossCash;

  const fees = stockFee + bondFee;

  // 3. Determine Withdrawal
  const totalAvailable = currStock + currBond + currCash;
  const actualWithdrawal = Math.min(state.spend, totalAvailable);

  let actionLog = "";

  // 4. Strategy Execution
  if (totalAvailable <= 0.01) {
    currStock = 0; currBond = 0; currCash = 0;
    actionLog = "Portfolio Depleted.";
  } else {
    if (isBucketStrategy) {
      // --- BUCKET STRATEGY ---
      const targetBuffer = 2 * state.spend; 
      let refillAmount = 0;
      
      // Rule: If Stocks are UP, sell gains to refill cash bucket
      if (returns.stock > 0 && currStock > 0 && currCash < targetBuffer) {
        const needed = targetBuffer - currCash;
        // Sell stock to fill bucket. Apply transaction cost to the sale.
        const grossSell = Math.min(needed, currStock);
        const netCashReceived = grossSell * (1 - TRANSACTION_COST); // Drag applied
        
        currStock -= grossSell;
        currCash += netCashReceived;
        refillAmount = netCashReceived;
      }

      // Spend Logic: Always try to spend from Cash first
      if (currCash >= actualWithdrawal) {
        currCash -= actualWithdrawal;
      } else {
        // Cash Empty! Forced Stock Sell.
        const shortfall = actualWithdrawal - currCash;
        currCash = 0;
        
        // We need to generate 'shortfall' amount of cash. 
        // Gross sell needed = shortfall / (1 - cost)
        const grossSellNeeded = shortfall / (1 - TRANSACTION_COST);
        
        currStock -= grossSellNeeded;
        if (currStock < 0) currStock = 0; 
      }

      if (returns.stock < 0) {
        actionLog = `Market Down ${(returns.stock*100).toFixed(1)}%.`;
        if (currCash > 0) actionLog += ` Spending from Cash Buffer.`;
        else actionLog += ` Cash Empty! Forced Sell.`;
      } else {
        actionLog = `Market Up ${(returns.stock*100).toFixed(1)}%.`;
        if (refillAmount > 0) actionLog += ` Refilled Cash ($${Math.round(refillAmount/1000)}k).`;
      }

    } else {
      // --- FIXED ALLOCATION STRATEGY ---
      let total = currStock + currBond + currCash;
      
      // Apply Withdrawal
      total -= actualWithdrawal;

      // Apply Rebalancing Friction/Drag (Standardized with Bucket)
      total -= total * TRANSACTION_COST; 

      if (total > 0.01) {
        currStock = total * targetWeights.stock;
        currBond = total * targetWeights.bond;
        currCash = 0; 
        actionLog = `Rebalanced to ${Math.round(targetWeights.stock*100)}/${Math.round(targetWeights.bond*100)}.`;
      } else {
        currStock = 0; currBond = 0; currCash = 0;
        actionLog = "Portfolio Depleted.";
      }
    }
  }

  return {
    nextState: {
      stock: currStock,
      bond: currBond,
      cash: currCash,
      spend: state.spend 
    },
    withdrawal: actualWithdrawal,
    fees,
    growth,
    actionLog
  };
};

const generateAuditLog = (
  inputs: SimulationInputs, 
  strategy: StrategyType, 
  annualReturns: { stock: number, bond: number, cash: number }[]
): AuditRow[] => {
  const log: AuditRow[] = [];
  const { initialCash, initialInvestments, annualSpend, customStockAllocation } = inputs;
  const totalStartPortfolio = initialCash + initialInvestments;

  let targetStockWeight = 0;
  let targetBondWeight = 0;
  if (strategy === 'CONSERVATIVE') { targetBondWeight = 0.40; targetStockWeight = 0.60; }
  else if (strategy === 'AGGRESSIVE') { targetBondWeight = 0.30; targetStockWeight = 0.70; }
  else if (strategy === 'CUSTOM') { targetStockWeight = customStockAllocation / 100; targetBondWeight = 1.0 - targetStockWeight; }

  let state: SimState = {
    stock: 0, bond: 0, cash: 0, spend: annualSpend
  };

  if (strategy === 'BUCKET') {
    const targetCashBuffer = 2 * annualSpend;
    state.cash = Math.min(totalStartPortfolio, targetCashBuffer);
    state.stock = totalStartPortfolio - state.cash;
    state.bond = 0;
  } else {
    state.stock = totalStartPortfolio * targetStockWeight;
    state.bond = totalStartPortfolio * targetBondWeight;
    state.cash = 0;
  }

  for (let year = 1; year <= inputs.timeHorizon; year++) {
    const startCash = state.cash;
    const startStock = state.stock;
    const startBond = state.bond;

    const returns = annualReturns[year - 1];

    const outcome = simulateYear(state, returns, inputs, strategy, { stock: targetStockWeight, bond: targetBondWeight });

    log.push({
      year: new Date().getFullYear() + year,
      startCash,
      startStock,
      startBond,
      stockReturn: returns.stock,
      bondReturn: returns.bond,
      cashReturn: returns.cash,
      growthAmount: outcome.growth,
      feesAmount: outcome.fees,
      action: outcome.actionLog,
      withdrawal: outcome.withdrawal,
      endTotal: outcome.nextState.stock + outcome.nextState.bond + outcome.nextState.cash
    });

    state = outcome.nextState;
  }
  return log;
};

// 4. MAIN EXPORT

export const runSimulation = (
  inputs: SimulationInputs,
  strategy: StrategyType
): SimulationResult => {
  const { initialCash, initialInvestments, annualSpend, timeHorizon, customStockAllocation, inflationRate } = inputs;
  const totalStartPortfolio = initialCash + initialInvestments;
  
  let targetStockWeight = 0;
  let targetBondWeight = 0;
  if (strategy === 'CONSERVATIVE') { targetBondWeight = 0.40; targetStockWeight = 0.60; }
  else if (strategy === 'AGGRESSIVE') { targetBondWeight = 0.30; targetStockWeight = 0.70; }
  else if (strategy === 'CUSTOM') { targetStockWeight = customStockAllocation / 100; targetBondWeight = 1.0 - targetStockWeight; }

  const inflate = (val: number) => (1 + val) / (1 + inflationRate / 100) - 1;
  const deflateVol = (val: number) => val / (1 + inflationRate / 100);

  const REAL_ASSUMPTIONS = {
    STOCK: { mean: inflate(NOMINAL_ASSUMPTIONS.STOCK.mean), stdDev: deflateVol(NOMINAL_ASSUMPTIONS.STOCK.stdDev) },
    BOND:  { mean: inflate(NOMINAL_ASSUMPTIONS.BOND.mean), stdDev: deflateVol(NOMINAL_ASSUMPTIONS.BOND.stdDev) },
    CASH:  { mean: inflate(NOMINAL_ASSUMPTIONS.CASH.mean), stdDev: deflateVol(NOMINAL_ASSUMPTIONS.CASH.stdDev) },
  };

  const allRuns: SimulationRun[] = [];
  // Use Float64Array for column-based storage (Performance Optimization)
  const trajectoryColumns: Float64Array[] = Array(timeHorizon).fill(0).map(() => new Float64Array(NUM_SIMULATIONS));
  
  let failures = 0;
  let totalAnnualizedVol = 0;

  for (let sim = 0; sim < NUM_SIMULATIONS; sim++) {
    // Initial State
    let state: SimState = {
      stock: 0, bond: 0, cash: 0, spend: annualSpend
    };

    if (strategy === 'BUCKET') {
      const targetCashBuffer = 2 * annualSpend;
      state.cash = Math.min(totalStartPortfolio, targetCashBuffer);
      state.stock = totalStartPortfolio - state.cash;
      state.bond = 0;
    } else {
      state.stock = totalStartPortfolio * targetStockWeight;
      state.bond = totalStartPortfolio * targetBondWeight;
      state.cash = 0;
    }

    const currentRunReturns: { stock: number; bond: number; cash: number }[] = [];
    // Store local trajectory for this run in a typed array
    const currentRunTrajectory = new Float64Array(timeHorizon);
    const runPortfolioReturns: number[] = [];
    
    let prevBalance = totalStartPortfolio;

    for (let year = 0; year < timeHorizon; year++) {
      const returns = generateAnnualReturns(REAL_ASSUMPTIONS);
      currentRunReturns.push(returns);

      const outcome = simulateYear(state, returns, inputs, strategy, { stock: targetStockWeight, bond: targetBondWeight });

      state = outcome.nextState;

      let totalPortfolio = state.stock + state.bond + state.cash;
      if (totalPortfolio < 0) totalPortfolio = 0;
      
      if (prevBalance > 0.01) {
        const performance = ((totalPortfolio + outcome.withdrawal) / prevBalance) - 1;
        runPortfolioReturns.push(performance);
      }

      currentRunTrajectory[year] = totalPortfolio;
      trajectoryColumns[year][sim] = totalPortfolio;
      prevBalance = totalPortfolio;
    }
    
    const finalVal = state.stock + state.bond + state.cash;
    if (finalVal <= 1) failures++;

    let variance = 0;
    if (runPortfolioReturns.length > 0) {
      const meanR = runPortfolioReturns.reduce((a,b) => a+b, 0) / runPortfolioReturns.length;
      variance = runPortfolioReturns.reduce((sq, n) => sq + Math.pow(n - meanR, 2), 0) / runPortfolioReturns.length;
    }
    totalAnnualizedVol += Math.sqrt(variance);
    
    // We only store the full object if we might need it, but we can't optimize this fully away 
    // without refactoring how audit logs are retrieved.
    allRuns.push({
      id: sim,
      finalBalance: finalVal,
      trajectory: currentRunTrajectory,
      annualReturns: currentRunReturns,
      portfolioReturns: runPortfolioReturns
    });
  }

  // --- Aggregation & Output Generation ---

  const averageCurve: number[] = [];
  const belowAverageCurve: number[] = [];
  const downturnCurve: number[] = [];
  const currentYear = new Date().getFullYear();

  // Sort columns to find percentiles (Much faster than full run sorts for every year)
  for(let i=0; i<timeHorizon; i++) {
     const yearValues = trajectoryColumns[i].sort();
     downturnCurve.push(yearValues[Math.floor(NUM_SIMULATIONS * 0.10)]);
     belowAverageCurve.push(yearValues[Math.floor(NUM_SIMULATIONS * 0.25)]);
     averageCurve.push(yearValues[Math.floor(NUM_SIMULATIONS * 0.50)]);
  }

  const chartData: YearResult[] = averageCurve.map((val, idx) => ({
    year: currentYear + idx + 1,
    average: val,
    belowAverage: belowAverageCurve[idx],
    downturn: downturnCurve[idx]
  }));
  
  chartData.unshift({
    year: currentYear,
    average: totalStartPortfolio,
    belowAverage: totalStartPortfolio,
    downturn: totalStartPortfolio
  });

  // PERFORMANCE FIX: Simplify Best Fit Selection
  // Instead of expensive O(N*T) distance calculation, just sort runs by final balance 
  // and pick the ones at the specific percentiles. It's statistically sufficient.
  allRuns.sort((a, b) => a.finalBalance - b.finalBalance);

  const downturnRun = allRuns[Math.floor(NUM_SIMULATIONS * 0.10)];
  const belowAvgRun = allRuns[Math.floor(NUM_SIMULATIONS * 0.25)];
  const medianRun = allRuns[Math.floor(NUM_SIMULATIONS * 0.50)];

  const auditLogAverage = generateAuditLog(inputs, strategy, medianRun.annualReturns);
  const auditLogBelowAverage = generateAuditLog(inputs, strategy, belowAvgRun.annualReturns);
  const auditLogDownturn = generateAuditLog(inputs, strategy, downturnRun.annualReturns);

  const finalMedian = medianRun.finalBalance;
  const avgVol = (totalAnnualizedVol / NUM_SIMULATIONS) * 100;

  // Display Allocation Calc
  let dispStock = targetStockWeight;
  let dispBond = targetBondWeight;
  let dispCash = 0;
  if (strategy === 'BUCKET') {
    const startCash = Math.min(totalStartPortfolio, 2 * annualSpend);
    dispCash = startCash / totalStartPortfolio;
    dispStock = 1.0 - dispCash;
    dispBond = 0;
  }

  return {
    data: chartData,
    auditLogAverage,
    auditLogBelowAverage,
    auditLogDownturn,
    successRate: ((NUM_SIMULATIONS - failures) / NUM_SIMULATIONS) * 100,
    finalMedianValue: finalMedian,
    volatility: avgVol,
    allocation: { stock: dispStock, bond: dispBond, cash: dispCash },
    timestamp: Date.now()
  };
};