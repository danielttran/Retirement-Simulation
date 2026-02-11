import { SimulationInputs, SimulationResult, StrategyType, YearResult, AuditRow } from '../types';

// 1. CONFIGURATION & CONSTANTS

// Nominal Return Assumptions (Long-term historical averages)
// We will adjust these dynamically based on the user's inflation input to get Real Returns.
const NOMINAL_ASSUMPTIONS = {
  STOCK: { mean: 0.085, stdDev: 0.17 }, // ~8.5% Nominal, 17% Vol
  BOND:  { mean: 0.040, stdDev: 0.05 }, // ~4.0% Nominal, 5% Vol
  CASH:  { mean: 0.025, stdDev: 0.015 }, // ~2.5% Nominal, 1.5% Vol
};

// Correlation Matrix (Stocks, Bonds, Cash)
// Modern correlation assumption: Stocks/Bonds have slight negative correlation
const CORRELATION_MATRIX = [
  [1.00, -0.15, 0.05],  // Stock-Stock, Stock-Bond, Stock-Cash
  [-0.15, 1.00, 0.15],  // Bond-Stock, Bond-Bond, Bond-Cash
  [0.05, 0.15, 1.00],   // Cash-Stock, Cash-Bond, Cash-Cash
];

const NUM_SIMULATIONS = 10000; // Updated to match UI claim

// 2. MATHEMATICAL HELPERS

// Box-Muller transform for standard normal distribution (Mean 0, StdDev 1)
function randn_bm() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// Cholesky Decomposition to turn Correlation Matrix into Lower Triangular Matrix (L)
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

// Pre-compute L since Correlation Matrix is constant
const CHOL_L = choleskyDecompose(CORRELATION_MATRIX);

/**
 * Generates correlated log-normal returns for Stock, Bond, Cash
 * @param realAssumptions - The expected REAL return (Mean) and StdDev for each asset
 */
function generateAnnualReturns(realAssumptions: typeof NOMINAL_ASSUMPTIONS) {
  // 1. Generate 3 independent standard normal random variables
  const Z = [randn_bm(), randn_bm(), randn_bm()];

  // 2. Apply Cholesky matrix to correlate them
  // correlated_Z = L * Z
  const Z_corr = [
    CHOL_L[0][0] * Z[0],
    CHOL_L[1][0] * Z[0] + CHOL_L[1][1] * Z[1],
    CHOL_L[2][0] * Z[0] + CHOL_L[2][1] * Z[1] + CHOL_L[2][2] * Z[2]
  ];

  // 3. Convert to Log-Normal Returns
  // Formula: Return = exp(mu_log + sigma_log * Z) - 1
  // We first convert Arithmetic Mean/StdDev to Log-Normal Parameters
  const getLogParams = (arithMean: number, arithStd: number) => {
    // 1 + r
    const term = 1 + arithMean;
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
  trajectory: number[];
  annualReturns: { stock: number; bond: number; cash: number }[];
  portfolioReturns: number[]; // Track annual portfolio performance for volatility calc
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
  const startTotal = state.stock + state.bond + state.cash;

  // 1. Apply Market Returns (Log-Normal Correlated)
  const grossStock = state.stock * (1 + returns.stock);
  const grossBond = state.bond * (1 + returns.bond);
  const grossCash = state.cash * (1 + returns.cash);
  
  const growth = (grossStock - state.stock) + (grossBond - state.bond) + (grossCash - state.cash);

  // 2. Apply Fees (Advisory fee applies to invested assets: Stocks + Bonds)
  // We deduct this at year end before rebalancing
  const feeRate = managementFee / 100;
  const stockFee = grossStock * feeRate;
  const bondFee = grossBond * feeRate;
  
  let currStock = grossStock - stockFee;
  let currBond = grossBond - bondFee;
  let currCash = grossCash;

  const fees = stockFee + bondFee;

  // 3. Determine Withdrawal
  // Note: We are working in REAL dollars, so 'spend' is constant purchasing power.
  // We do not inflate the spend amount because returns are already deflated.
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
      // Target Buffer is 2 years of spending (Real Dollars)
      const targetBuffer = 2 * state.spend; 
      
      let refillAmount = 0;
      
      // Rule: If Stocks are UP, sell gains to refill cash bucket
      if (returns.stock > 0 && currStock > 0 && currCash < targetBuffer) {
        const needed = targetBuffer - currCash;
        // Don't sell more than the gain? Or sell principal? 
        // Aggressive bucket strategy: Sell whatever is needed from stocks to fill bucket if market is up.
        refillAmount = Math.min(needed, currStock);
        currStock -= refillAmount;
        currCash += refillAmount;
      }

      // Spend Logic: Always try to spend from Cash first
      let spendFromCash = 0;
      if (currCash >= actualWithdrawal) {
        currCash -= actualWithdrawal;
        spendFromCash = actualWithdrawal;
      } else {
        spendFromCash = currCash;
        const shortfall = actualWithdrawal - currCash;
        currCash = 0;
        // Forced to sell stock in a down market if cash empty
        currStock -= shortfall;
        if (currStock < 0) currStock = 0; 
      }

      if (returns.stock < 0) {
        actionLog = `Market Down ${(returns.stock*100).toFixed(1)}%.`;
        if (currCash > 0) actionLog += ` Spending from Cash Buffer.`;
        else actionLog += ` Cash Empty! Forced Stock Sell.`;
      } else {
        actionLog = `Market Up ${(returns.stock*100).toFixed(1)}%.`;
        if (refillAmount > 0) actionLog += ` Refilled Cash ($${Math.round(refillAmount/1000)}k).`;
      }

    } else {
      // --- FIXED ALLOCATION STRATEGY ---
      let total = currStock + currBond + currCash;
      
      // Apply Withdrawal
      total -= actualWithdrawal;

      // Apply Rebalancing Friction/Drag
      // Assume 0.05% of total portfolio lost to spreads/commissions/tax-drag during annual rebalance
      const rebalanceDrag = total * 0.0005;
      total -= rebalanceDrag;

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
      spend: state.spend // Real spending remains constant
    },
    withdrawal: actualWithdrawal,
    fees,
    growth,
    actionLog
  };
};

// ... generateAuditLog and findBestFitRun helper functions remain largely the same structure, 
// just updated to use the new math via 'simulateYear' ...
// For brevity in the diff, I will re-implement them to ensure context is kept.

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

const getTerminalStats = (trajectory: number[]) => {
  const depletionIndex = trajectory.findIndex(v => v <= 0.01); 
  return {
    depleted: depletionIndex !== -1,
    depletionYear: depletionIndex,
    finalValue: trajectory[trajectory.length - 1]
  };
};

const findBestFitRun = (
  allRuns: SimulationRun[], 
  targetCurve: number[],
  comparisonFn?: (runVal: number, compareVal: number) => boolean,
  comparisonCurve?: number[]
): SimulationRun => {
  const targetStats = getTerminalStats(targetCurve);
  let candidates = allRuns;

  if (targetStats.depleted) {
     candidates = allRuns.filter(r => {
        const rStats = getTerminalStats(r.trajectory);
        return rStats.depleted && Math.abs(rStats.depletionYear - targetStats.depletionYear) <= 1;
     });
  } else {
     const tolerances = [0.01, 0.02, 0.05, 0.10, 0.20];
     for (const tol of tolerances) {
        const filtered = allRuns.filter(r => {
             const val = r.trajectory[r.trajectory.length - 1];
             const diff = Math.abs(val - targetStats.finalValue);
             return diff <= (targetStats.finalValue * tol);
        });
        if (filtered.length > 5) {
            candidates = filtered;
            break;
        }
     }
  }
  if (candidates.length === 0) candidates = allRuns;

  let bestRun = candidates[0];
  let minError = Number.MAX_VALUE;

  for (const run of candidates) {
    let error = 0;
    let penalty = 0;
    for (let i = 0; i < targetCurve.length; i++) {
        if (i < run.trajectory.length) {
            const diff = run.trajectory[i] - targetCurve[i];
            error += diff * diff;
            if (comparisonFn && comparisonCurve) {
              if (!comparisonFn(run.trajectory[i], comparisonCurve[i])) {
                penalty += 1e12;
              }
            }
        }
    }
    if ((error + penalty) < minError) {
      minError = error + penalty;
      bestRun = run;
    }
  }
  return bestRun;
};

// 4. MAIN EXPORT

export const runSimulation = (
  inputs: SimulationInputs,
  strategy: StrategyType
): SimulationResult => {
  const { initialCash, initialInvestments, annualSpend, timeHorizon, customStockAllocation, inflationRate } = inputs;
  const totalStartPortfolio = initialCash + initialInvestments;
  
  // Weights setup
  let targetStockWeight = 0;
  let targetBondWeight = 0;
  if (strategy === 'CONSERVATIVE') { targetBondWeight = 0.40; targetStockWeight = 0.60; }
  else if (strategy === 'AGGRESSIVE') { targetBondWeight = 0.30; targetStockWeight = 0.70; }
  else if (strategy === 'CUSTOM') { targetStockWeight = customStockAllocation / 100; targetBondWeight = 1.0 - targetStockWeight; }

  // Adjust Returns for Inflation (Fisher Equation approximation: r_real = (1+r_nom)/(1+i) - 1)
  // Or simply subtraction for small rates: r_real = r_nom - i
  // We will use the accurate division method for precision
  const inflate = (val: number) => (1 + val) / (1 + inflationRate / 100) - 1;
  const deflateVol = (val: number) => val / (1 + inflationRate / 100);

  const REAL_ASSUMPTIONS = {
    STOCK: { mean: inflate(NOMINAL_ASSUMPTIONS.STOCK.mean), stdDev: deflateVol(NOMINAL_ASSUMPTIONS.STOCK.stdDev) },
    BOND:  { mean: inflate(NOMINAL_ASSUMPTIONS.BOND.mean), stdDev: deflateVol(NOMINAL_ASSUMPTIONS.BOND.stdDev) },
    CASH:  { mean: inflate(NOMINAL_ASSUMPTIONS.CASH.mean), stdDev: deflateVol(NOMINAL_ASSUMPTIONS.CASH.stdDev) },
  };

  const allRuns: SimulationRun[] = [];
  const trajectories: number[][] = Array(timeHorizon).fill(0).map(() => []);
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
    const currentRunTrajectory: number[] = [];
    const runPortfolioReturns: number[] = [];
    
    let prevBalance = totalStartPortfolio;

    for (let year = 0; year < timeHorizon; year++) {
      // Generate Correlated Real Returns
      const returns = generateAnnualReturns(REAL_ASSUMPTIONS);
      currentRunReturns.push(returns);

      const outcome = simulateYear(state, returns, inputs, strategy, { stock: targetStockWeight, bond: targetBondWeight });

      state = outcome.nextState;

      let totalPortfolio = state.stock + state.bond + state.cash;
      if (totalPortfolio < 0) totalPortfolio = 0;
      
      // Calculate Portfolio Return for this year (for volatility calc)
      // Return = (EndBalance + Withdrawal) / StartBalance - 1
      // We add withdrawal back to see the performance of the assets themselves
      if (prevBalance > 0.01) {
        const performance = ((totalPortfolio + outcome.withdrawal) / prevBalance) - 1;
        runPortfolioReturns.push(performance);
      }

      currentRunTrajectory.push(totalPortfolio);
      trajectories[year].push(totalPortfolio);
      prevBalance = totalPortfolio;
    }
    
    const finalVal = state.stock + state.bond + state.cash;
    if (finalVal <= 1) failures++;

    // Calculate annualized volatility for this run
    let variance = 0;
    if (runPortfolioReturns.length > 0) {
      const meanR = runPortfolioReturns.reduce((a,b) => a+b, 0) / runPortfolioReturns.length;
      variance = runPortfolioReturns.reduce((sq, n) => sq + Math.pow(n - meanR, 2), 0) / runPortfolioReturns.length;
    }
    totalAnnualizedVol += Math.sqrt(variance);
    
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

  const chartData: YearResult[] = trajectories.map((yearValues, index) => {
    yearValues.sort((a, b) => a - b);
    
    const dVal = yearValues[Math.floor(NUM_SIMULATIONS * 0.10)];
    const bVal = yearValues[Math.floor(NUM_SIMULATIONS * 0.25)];
    const aVal = yearValues[Math.floor(NUM_SIMULATIONS * 0.50)];

    downturnCurve.push(dVal);
    belowAverageCurve.push(bVal);
    averageCurve.push(aVal);

    return {
      year: currentYear + index + 1,
      downturn: dVal, 
      belowAverage: bVal, 
      average: aVal, 
    };
  });
  
  chartData.unshift({
    year: currentYear,
    average: totalStartPortfolio,
    belowAverage: totalStartPortfolio,
    downturn: totalStartPortfolio
  });

  // Select representative runs for audit
  const downturnRun = findBestFitRun(allRuns, downturnCurve);
  const belowAvgRun = findBestFitRun(allRuns, belowAverageCurve, (val, compareVal) => val >= compareVal, downturnRun.trajectory);
  const medianRun = findBestFitRun(allRuns, averageCurve, (val, compareVal) => val >= compareVal, belowAvgRun.trajectory);

  const auditLogAverage = generateAuditLog(inputs, strategy, medianRun.annualReturns);
  const auditLogBelowAverage = generateAuditLog(inputs, strategy, belowAvgRun.annualReturns);
  const auditLogDownturn = generateAuditLog(inputs, strategy, downturnRun.annualReturns);

  // Final Stats
  const allFinals = allRuns.map(r => r.finalBalance).sort((a,b) => a-b);
  const finalMedian = allFinals[Math.floor(NUM_SIMULATIONS * 0.50)];
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