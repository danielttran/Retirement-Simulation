import { SimulationInputs, SimulationResult, StrategyType, YearResult, AuditRow, SpendingPhase } from '../types';

/**
 * Returns the annual spend amount for a given simulation year (0-based).
 * Phases are contiguous and cover [0, timeHorizon) — the last matching phase wins.
 */
export function getSpendingForYear(year: number, phases: SpendingPhase[]): number {
  for (let i = phases.length - 1; i >= 0; i--) {
    if (year >= phases[i].startYear) return phases[i].annualSpend;
  }
  return phases[0].annualSpend;
}

// 1. CONFIGURATION & CONSTANTS

const TRANSACTION_COST = 0.0005; // 0.05% friction on selling/rebalancing

// ---------------------------------------------------------------------------
// RMD — IRS Uniform Lifetime Table (Publication 590-B, SECURE 2.0 / 2022+)
// RMD threshold is age 73 (born 1951–1959) or 75 (born 1960+).
// For simplicity we apply age 73 as the universal trigger; the UI can surface
// the 73 vs. 75 distinction when a full birth-year field is added.
// ---------------------------------------------------------------------------
const RMD_AGE_THRESHOLD = 73;
const RMD_FACTORS: Readonly<Record<number, number>> = {
  73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9,
  78: 22.0, 79: 21.1, 80: 20.2, 81: 19.4, 82: 18.5,
  83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4,
  88: 13.7, 89: 12.9, 90: 12.2, 91: 11.5, 92: 10.8,
  93: 10.1, 94:  9.5, 95:  8.9, 96:  8.4, 97:  7.8,
  98:  7.3, 99:  6.8, 100: 6.4,
};

/**
 * Computes the IRS-required minimum distribution in real (today's) dollars.
 *
 * The simulation runs entirely in real terms, so the portfolio balance passed
 * in is already inflation-adjusted. Since real_balance = nominal / (1+π)^t
 * and RMD = nominal_balance / factor, the real RMD = real_balance / factor.
 *
 * @param realBalance  Total portfolio value in today's dollars.
 * @param age          Client's age in the simulation year being computed.
 * @param taxDeferredRatio  Fraction (0–100) of the portfolio in tax-deferred accounts.
 * @returns Real-dollar RMD (≥ 0).
 */
function computeRMD(realBalance: number, age: number, taxDeferredRatio: number): number {
  if (age < RMD_AGE_THRESHOLD || taxDeferredRatio <= 0) return 0;
  const factor = RMD_FACTORS[Math.min(age, 100)] ?? 6.4; // cap factor at age-100 value
  return (realBalance * (taxDeferredRatio / 100)) / factor;
}

// Nominal Return Assumptions (Long-term historical averages)
const NOMINAL_ASSUMPTIONS = {
  STOCK: { mean: 0.085, stdDev: 0.17 }, // ~8.5% Nominal, 17% Vol
  BOND: { mean: 0.040, stdDev: 0.05 }, // ~4.0% Nominal, 5% Vol
  CASH: { mean: 0.025, stdDev: 0.015 }, // ~2.5% Nominal, 1.5% Vol
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
    bond: Math.exp(bParams.mu_log + bParams.sigma_log * Z_corr[1]) - 1,
    cash: Math.exp(cParams.mu_log + cParams.sigma_log * Z_corr[2]) - 1,
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
  // Cap at what can actually be realised after liquidation costs (Bug 1 fix).
  const totalAvailable = currStock + currBond + currCash;
  const actualWithdrawal = Math.min(state.spend, totalAvailable * (1 - TRANSACTION_COST));

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
        // Gross-up: sell enough stock so that net proceeds after cost equal exactly `needed`
        // (Bug 3 fix — selling exactly `needed` only delivers needed*(1-cost) < needed).
        const grossSellNeeded = needed / (1 - TRANSACTION_COST);
        const grossSell = Math.min(grossSellNeeded, currStock);
        const netCashReceived = grossSell * (1 - TRANSACTION_COST);

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
        actionLog = `Market Down ${(returns.stock * 100).toFixed(1)}%.`;
        if (currCash > 0) actionLog += ` Spending from Cash Buffer.`;
        else actionLog += ` Cash Empty! Forced Sell.`;
      } else {
        actionLog = `Market Up ${(returns.stock * 100).toFixed(1)}%.`;
        if (refillAmount > 0) actionLog += ` Refilled Cash ($${Math.round(refillAmount / 1000)}k).`;
      }

    } else {
      // --- FIXED ALLOCATION STRATEGY ---
      let total = currStock + currBond + currCash;

      // Apply Withdrawal
      total -= actualWithdrawal;

      if (total > 0.01) {
        // Calculate rebalancing trades and apply transaction cost only to traded amount
        const targetStock = total * targetWeights.stock;
        const targetBond = total * targetWeights.bond;
        const tradeAmount = Math.abs(currStock - targetStock) + Math.abs(currBond - targetBond);
        // Apply cost to the total gross traded volume; the /2 approximation only holds for
        // pure rebalances with no net outflow, not when funding a withdrawal (Bug 2 fix).
        const rebalancingCost = tradeAmount * TRANSACTION_COST;
        total -= rebalancingCost;

        currStock = total * targetWeights.stock;
        currBond = total * targetWeights.bond;
        currCash = 0;
        actionLog = `Rebalanced to ${Math.round(targetWeights.stock * 100)}/${Math.round(targetWeights.bond * 100)}.`;
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
  const { initialCash, initialInvestments, spendingPhases, customStockAllocation } = inputs;
  const totalStartPortfolio = initialCash + initialInvestments;

  let targetStockWeight = 0;
  let targetBondWeight = 0;
  if (strategy === 'CONSERVATIVE') { targetBondWeight = 0.40; targetStockWeight = 0.60; }
  else if (strategy === 'AGGRESSIVE') { targetBondWeight = 0.30; targetStockWeight = 0.70; }
  else if (strategy === 'CUSTOM') { targetStockWeight = customStockAllocation / 100; targetBondWeight = 1.0 - targetStockWeight; }

  const initialSpend = getSpendingForYear(0, spendingPhases);
  let state: SimState = {
    stock: 0, bond: 0, cash: 0, spend: initialSpend
  };

  if (strategy === 'BUCKET') {
    // Bug 5 fix (mirror of runSimulation initial state).
    const targetCashBuffer = 2 * initialSpend;
    if (initialCash >= targetCashBuffer) {
      state.cash = targetCashBuffer;
      state.stock = totalStartPortfolio - targetCashBuffer;
    } else {
      const cashNeeded = targetCashBuffer - initialCash;
      const grossSellNeeded = cashNeeded / (1 - TRANSACTION_COST);
      const grossSell = Math.min(grossSellNeeded, initialInvestments);
      state.cash = initialCash + grossSell * (1 - TRANSACTION_COST);
      state.stock = initialInvestments - grossSell;
    }
    state.bond = 0;
  } else {
    // Bug 5 fix (mirror of runSimulation initial state).
    const stocksToSell = Math.max(0, initialInvestments - totalStartPortfolio * targetStockWeight);
    const setupCost = stocksToSell * TRANSACTION_COST;
    const effectiveTotal = totalStartPortfolio - setupCost;
    state.stock = effectiveTotal * targetStockWeight;
    state.bond = effectiveTotal * targetBondWeight;
    state.cash = 0;
  }

  for (let year = 1; year <= inputs.timeHorizon; year++) {
    // Update spend for the current phase (year is 1-based; convert to 0-based for lookup)
    const baseSpend = getSpendingForYear(year - 1, spendingPhases);

    // --- RMD & Tax Gross-Up ---
    // 1. RMD: compute IRS-mandated minimum withdrawal for this year.
    const ageThisYear = inputs.currentAge + year;
    const totalPreWithdrawal = state.stock + state.bond + state.cash;
    const rmdAmount = computeRMD(totalPreWithdrawal, ageThisYear, inputs.taxDeferredRatio);

    // 2. Tax gross-up: to receive `baseSpend` after paying withdrawalTaxRate,
    //    the portfolio must liquidate baseSpend / (1 - taxRate).
    const taxRate = inputs.withdrawalTaxRate / 100;
    const grossBaseSpend = taxRate > 0 ? baseSpend / (1 - taxRate) : baseSpend;

    // 3. The effective portfolio draw is the larger of the user's gross intent and the RMD.
    state.spend = Math.max(grossBaseSpend, rmdAmount);

    const startCash = state.cash;
    const startStock = state.stock;
    const startBond = state.bond;

    const returns = annualReturns[year - 1];

    const outcome = simulateYear(state, returns, inputs, strategy, { stock: targetStockWeight, bond: targetBondWeight });

    // Nominal withdrawal = real withdrawal × cumulative inflation factor for CPA / 1099-R reference
    const inflationFactor = Math.pow(1 + inputs.inflationRate / 100, year);
    const nominalWithdrawal = outcome.withdrawal * inflationFactor;

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
      endTotal: outcome.nextState.stock + outcome.nextState.bond + outcome.nextState.cash,
      rmdAmount,
      nominalWithdrawal,
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
  const { initialCash, initialInvestments, spendingPhases, timeHorizon, customStockAllocation, inflationRate } = inputs;
  const totalStartPortfolio = initialCash + initialInvestments;

  let targetStockWeight = 0;
  let targetBondWeight = 0;
  if (strategy === 'CONSERVATIVE') { targetBondWeight = 0.40; targetStockWeight = 0.60; }
  else if (strategy === 'AGGRESSIVE') { targetBondWeight = 0.30; targetStockWeight = 0.70; }
  else if (strategy === 'CUSTOM') { targetStockWeight = customStockAllocation / 100; targetBondWeight = 1.0 - targetStockWeight; }

  const inflationDivisor = 1 + inflationRate / 100;
  const inflate = (val: number) => (1 + val) / inflationDivisor - 1;

  // Variance properties require scaling stdDev by the same divisor as the mean.
  // Real return = Nominal return / inflationDivisor  →  σ_real = σ_nominal / inflationDivisor
  // (Bug 4 fix — previously the nominal stdDev was passed through unadjusted.)
  const REAL_ASSUMPTIONS = {
    STOCK: { mean: inflate(NOMINAL_ASSUMPTIONS.STOCK.mean), stdDev: NOMINAL_ASSUMPTIONS.STOCK.stdDev / inflationDivisor },
    BOND:  { mean: inflate(NOMINAL_ASSUMPTIONS.BOND.mean),  stdDev: NOMINAL_ASSUMPTIONS.BOND.stdDev  / inflationDivisor },
    CASH:  { mean: inflate(NOMINAL_ASSUMPTIONS.CASH.mean),  stdDev: NOMINAL_ASSUMPTIONS.CASH.stdDev  / inflationDivisor },
  };

  const allRuns: SimulationRun[] = [];
  // Use Float64Array for column-based storage (Performance Optimization)
  const trajectoryColumns: Float64Array[] = Array(timeHorizon).fill(0).map(() => new Float64Array(NUM_SIMULATIONS));

  let failures = 0;
  let totalAnnualizedVol = 0;

  const initialSpend = getSpendingForYear(0, spendingPhases);

  for (let sim = 0; sim < NUM_SIMULATIONS; sim++) {
    // Initial State
    let state: SimState = {
      stock: 0, bond: 0, cash: 0, spend: initialSpend
    };

    if (strategy === 'BUCKET') {
      // Bug 5 fix: converting investments → cash to fund the cash bucket incurs selling cost.
      const targetCashBuffer = 2 * initialSpend;
      if (initialCash >= targetCashBuffer) {
        // Already have enough cash; invest the surplus into stocks (buying — no cost).
        state.cash = targetCashBuffer;
        state.stock = totalStartPortfolio - targetCashBuffer;
      } else {
        // Sell investments to top up the cash bucket; gross-up so net cash == cashNeeded.
        const cashNeeded = targetCashBuffer - initialCash;
        const grossSellNeeded = cashNeeded / (1 - TRANSACTION_COST);
        const grossSell = Math.min(grossSellNeeded, initialInvestments);
        state.cash = initialCash + grossSell * (1 - TRANSACTION_COST);
        state.stock = initialInvestments - grossSell;
      }
      state.bond = 0;
    } else {
      // Bug 5 fix: assume initialInvestments are 100% stocks; selling the target-bond
      // allocation to buy bonds at T=0 incurs TRANSACTION_COST on the sold portion.
      const stocksToSell = Math.max(0, initialInvestments - totalStartPortfolio * targetStockWeight);
      const setupCost = stocksToSell * TRANSACTION_COST;
      const effectiveTotal = totalStartPortfolio - setupCost;
      state.stock = effectiveTotal * targetStockWeight;
      state.bond = effectiveTotal * targetBondWeight;
      state.cash = 0;
    }

    const currentRunReturns: { stock: number; bond: number; cash: number }[] = [];
    // Store local trajectory for this run in a typed array
    const currentRunTrajectory = new Float64Array(timeHorizon);
    const runPortfolioReturns: number[] = [];

    let prevBalance = totalStartPortfolio;

    for (let year = 0; year < timeHorizon; year++) {
      // Update spend for the current phase before simulateYear consumes state.spend
      const baseSpend = getSpendingForYear(year, spendingPhases);

      // --- RMD & Tax Gross-Up (mirrors generateAuditLog logic exactly) ---
      const ageThisYear = inputs.currentAge + year;
      const totalPreWithdrawal = state.stock + state.bond + state.cash;
      const rmdThisYear = computeRMD(totalPreWithdrawal, ageThisYear, inputs.taxDeferredRatio);
      const taxRate = inputs.withdrawalTaxRate / 100;
      const grossBaseSpend = taxRate > 0 ? baseSpend / (1 - taxRate) : baseSpend;
      state.spend = Math.max(grossBaseSpend, rmdThisYear);

      const returns = generateAnnualReturns(REAL_ASSUMPTIONS);
      // Cash (HYSA/money market) cannot have negative nominal returns.
      // In real terms, the floor is 0% nominal → real = -inflation/(1+inflation)
      const minRealCashReturn = -(inflationRate / 100) / (1 + inflationRate / 100);
      returns.cash = Math.max(returns.cash, minRealCashReturn);
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
      const meanR = runPortfolioReturns.reduce((a, b) => a + b, 0) / runPortfolioReturns.length;
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
  for (let i = 0; i < timeHorizon; i++) {
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

  // Best-Fit Run Selection: Find the run whose year-by-year trajectory is closest
  // to each percentile curve. This ensures chart and audit tell the same story.
  const findBestFitRun = (targetCurve: number[]): SimulationRun => {
    let bestRun = allRuns[0];
    let bestDist = Infinity;
    for (let i = 0; i < allRuns.length; i++) {
      const run = allRuns[i];
      let dist = 0;
      for (let y = 0; y < timeHorizon; y++) {
        const diff = run.trajectory[y] - targetCurve[y];
        dist += diff * diff;
      }
      if (dist < bestDist) {
        bestDist = dist;
        bestRun = run;
      }
    }
    return bestRun;
  };

  const medianRun = findBestFitRun(averageCurve);
  const belowAvgRun = findBestFitRun(belowAverageCurve);
  const downturnRun = findBestFitRun(downturnCurve);

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
    const startCash = Math.min(totalStartPortfolio, 2 * getSpendingForYear(0, spendingPhases));
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