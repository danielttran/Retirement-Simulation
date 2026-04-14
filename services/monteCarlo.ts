import { SimulationInputs, SimulationResult, StrategyType, YearResult, AuditRow, SpendingPhase } from '../types';

/**
 * Returns the annual spend amount for a given simulation year (0-based).
 * Phases are contiguous and cover [0, timeHorizon) — the last matching phase wins.
 */
export function getSpendingForYear(year: number, phases: SpendingPhase[]): number {
  // Guard: UI always provides at least one phase, but defend against empty array
  // to prevent a runtime crash on `phases[0]` in the fallback path.
  if (phases.length === 0) return 0;
  for (let i = phases.length - 1; i >= 0; i--) {
    if (year >= phases[i].startYear) return phases[i].annualSpend;
  }
  return phases[0].annualSpend;
}

// 1. CONFIGURATION & CONSTANTS

const TRANSACTION_COST = 0.0005; // 0.05% friction on selling/rebalancing

// ---------------------------------------------------------------------------
// RMD — IRS Uniform Lifetime Table (Publication 590-B, SECURE 2.0 / 2022+)
// ---------------------------------------------------------------------------
const RMD_FACTORS: Readonly<Record<number, number>> = {
  72: 27.4, 73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9,
  78: 22.0, 79: 21.1, 80: 20.2, 81: 19.4, 82: 18.5,
  83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4,
  88: 13.7, 89: 12.9, 90: 12.2, 91: 11.5, 92: 10.8,
  93: 10.1, 94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8,
  98: 7.3, 99: 6.8, 100: 6.4,
};

/**
 * Computes the IRS-required minimum distribution in real (today's) dollars.
 */
function computeRMD(realBalance: number, age: number, taxDeferredRatio: number, birthYear: number): number {
  if (taxDeferredRatio <= 0) return 0;
  
  let threshold = 73; // Default SECURE 2.0
  if (birthYear <= 1950) threshold = 72;
  else if (birthYear >= 1960) threshold = 75;

  if (age < threshold) return 0;

  const factor = RMD_FACTORS[Math.min(age, 100)] ?? 6.4; // cap factor at age-100 value
  return (realBalance * (taxDeferredRatio / 100)) / factor;
}

/**
 * Computes the grossed-up portfolio withdrawal needed in the first retirement year,
 * accounting for Social Security income and tax on tax-deferred withdrawals.
 *
 * Used to correctly size the BUCKET strategy's initial cash buffer so it exactly
 * matches what simulateYear will target in year 1 — preventing spurious stock
 * sells (when the buffer is too small) or excess idle cash (when too large).
 *
 * portfolioBalance is used to compute the year-1 RMD; passing totalStartPortfolio
 * is correct because the RMD is based on the Dec-31 prior-year balance (= the
 * initial state before any simulation-year-1 returns are applied).
 */
function computeFirstYearGrossedUpSpend(
  rawSpend: number,
  portfolioBalance: number,
  inputs: SimulationInputs
): number {
  const ageAtYear1 = inputs.currentAge + 1;
  let baseSpend = rawSpend;

  if (ageAtYear1 >= inputs.socialSecurityAge) {
    baseSpend -= inputs.socialSecurityIncome * 12;
  }

  const taxRate = inputs.withdrawalTaxRate / 100;
  const effTaxRate = taxRate * (inputs.taxDeferredRatio / 100);
  const rmdAmount = computeRMD(portfolioBalance, ageAtYear1, inputs.taxDeferredRatio, inputs.birthYear);

  let taxOwed = 0;
  if (baseSpend > 0) {
    const grossBaseSpend = effTaxRate > 0 && effTaxRate < 1 ? baseSpend / (1 - effTaxRate) : baseSpend;
    const taxFromNeeds = grossBaseSpend - baseSpend;
    const taxFromRMD = rmdAmount * taxRate;
    taxOwed = Math.max(taxFromNeeds, taxFromRMD);
  } else {
    taxOwed = rmdAmount * taxRate;
  }

  return baseSpend + taxOwed;
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

const NUM_SIMULATIONS = 100000;

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
 * Generates one year of correlated real returns with three enhancements over
 * the original fixed-inflation log-normal model:
 *
 * 1. STOCHASTIC INFLATION
 *    Inflation is modelled as N(meanInflation, inflationStdDev²) rather than the
 *    user's fixed rate. A correlation of −0.30 with the raw equity draw Z[0]
 *    captures the Fisher-effect observation that equity shock years often
 *    coincide with lower realised inflation (flight-to-safety, rate cuts).
 *    Each call therefore produces a different inflation realisation, which in
 *    turn shifts the entire real-return distribution for that year.
 *
 * 2. JUMP DIFFUSION — Fat Tails (Merton 1976)
 *    A 2 % annual probability of a severe equity shock (−20 % to −40 %
 *    multiplicative drawdown) is applied after the log-normal draw. This
 *    models black-swan crashes that pure log-normal distributions systematically
 *    underestimate. The multiplicative form (1+r_ln)(1−shock)−1 keeps returns
 *    bounded above −100 % and preserves the sign of the base draw.
 *    At 2 %/yr the expected number of crashes over a 40-year horizon is ~0.55,
 *    and the probability of at least one crash is ~55 % — empirically consistent
 *    with the post-WWII US equity record.
 *
 * 3. CASH FLOOR
 *    HYSA / money-market instruments cannot yield negative nominal returns.
 *    The real floor (0 % nominal) is computed from the year's stochastic
 *    inflation draw and applied here rather than in the calling loop.
 *
 * @param nominalAssumptions  Long-run nominal mean/stdDev for each asset class.
 * @param meanInflation       User's expected annual inflation rate (decimal, e.g. 0.03).
 * @param inflationStdDev     Annualised inflation volatility (default 1.5 %).
 */
function generateAnnualReturns(
  nominalAssumptions: typeof NOMINAL_ASSUMPTIONS,
  meanInflation: number,
  inflationStdDev = 0.015
): { stock: number; bond: number; cash: number; inflation: number } {

  // --- Step 1: Four independent standard-normal draws ---
  const Z = [randn_bm(), randn_bm(), randn_bm()];
  const Z_inf = randn_bm(); // idiosyncratic component for inflation

  // --- Step 2: Apply Cholesky for stock / bond / cash correlation ---
  const Z_corr = [
    CHOL_L[0][0] * Z[0],
    CHOL_L[1][0] * Z[0] + CHOL_L[1][1] * Z[1],
    CHOL_L[2][0] * Z[0] + CHOL_L[2][1] * Z[1] + CHOL_L[2][2] * Z[2]
  ];

  // --- Step 3: Stochastic inflation draw (correlated with raw equity shock) ---
  // inflationZ = ρ·Z_stock + √(1−ρ²)·Z_inf  (standard correlated-normal construction)
  // ρ = −0.30: high equity shock → lower realised inflation.
  const INFLATION_EQUITY_CORR = -0.30;
  const inflationZ = INFLATION_EQUITY_CORR * Z[0]
    + Math.sqrt(1 - INFLATION_EQUITY_CORR * INFLATION_EQUITY_CORR) * Z_inf;
  // Floor at −5 % to prevent extreme deflation from producing nonsensical real returns.
  const annualInflation  = Math.max(meanInflation + inflationStdDev * inflationZ, -0.05);
  const inflationDivisor = 1 + annualInflation;

  // --- Step 4: Per-year nominal → real conversion ---
  // Real return mean:  (1 + nomMean) / (1 + inflation) − 1
  // Real return stdDev: nomStd / (1 + inflation)  [variance-scaling property]
  const toReal = (nomMean: number, nomStd: number) => ({
    mean:   (1 + nomMean) / inflationDivisor - 1,
    stdDev: nomStd / inflationDivisor,
  });
  const sReal = toReal(nominalAssumptions.STOCK.mean, nominalAssumptions.STOCK.stdDev);
  const bReal = toReal(nominalAssumptions.BOND.mean,  nominalAssumptions.BOND.stdDev);
  const cReal = toReal(nominalAssumptions.CASH.mean,  nominalAssumptions.CASH.stdDev);

  // --- Step 5: Log-normal moment matching (unchanged from original) ---
  // Converts arithmetic mean / stdDev to log-normal parameters (μ_log, σ_log)
  // via the standard φ = √(σ² + μ²) shorthand.
  // Clamp μ > 0 to avoid NaN when real return mean approaches −1.
  const getLogParams = (arithMean: number, arithStd: number) => {
    const term     = Math.max(1 + arithMean, 0.0001);
    const phi      = Math.sqrt(arithStd * arithStd + term * term);
    const mu_log   = Math.log(term * term / phi);
    const sigma_log = Math.sqrt(Math.log(phi * phi / (term * term)));
    return { mu_log, sigma_log };
  };

  const sP = getLogParams(sReal.mean, sReal.stdDev);
  const bP = getLogParams(bReal.mean, bReal.stdDev);
  const cP = getLogParams(cReal.mean, cReal.stdDev);

  // --- Step 6: Draw log-normal returns ---
  let stockReturn = Math.exp(sP.mu_log + sP.sigma_log * Z_corr[0]) - 1;
  const bondReturn  = Math.exp(bP.mu_log + bP.sigma_log * Z_corr[1]) - 1;

  // Cash floor: 0 % nominal → real floor = −inflation / (1 + inflation)
  const minRealCash = -annualInflation / inflationDivisor;
  const cashReturn  = Math.max(
    Math.exp(cP.mu_log + cP.sigma_log * Z_corr[2]) - 1,
    minRealCash
  );

  // --- Step 7: Jump Diffusion — fat-tail equity shock ---
  // 2 % annual probability of a black-swan crash; magnitude drawn U[20 %, 40 %].
  // Applied multiplicatively: (1 + r_ln)(1 − shock) − 1
  if (Math.random() < 0.02) {
    const shock = 0.20 + Math.random() * 0.20; // uniform in [0.20, 0.40]
    stockReturn = (1 + stockReturn) * (1 - shock) - 1;
  }

  // Return the realised inflation alongside asset returns so callers can
  // accumulate a precise cumulative inflation factor for nominal-dollar reporting.
  return { stock: stockReturn, bond: bondReturn, cash: cashReturn, inflation: annualInflation };
}

// 3. SIMULATION LOGIC

interface SimulationRun {
  id: number;
  finalBalance: number;
  trajectory: Float64Array; // Memory Optimization
  annualReturns: { stock: number; bond: number; cash: number; inflation: number }[];
  portfolioReturns: number[];
}

interface SimState {
  stock: number;
  bond: number;
  cash: number;
  spend: number;
  /** Accumulated Guyton-Klinger spend-adjustment factor (starts at 1.0, updated permanently). */
  spendMultiplier: number;
  /** Initial Withdrawal Rate — set in year 0 as the baseline for G-K guardrail comparisons. */
  iwr: number;
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

  let fees = stockFee + bondFee;

  // 3. Determine Withdrawal
  // Cash can be spent directly at zero friction; only invested assets (stock/bond)
  // incur a liquidation cost. Cap actualWithdrawal at the true maximum realizable
  // amount so we never strand cash in the final year of a depleted portfolio.
  const totalAvailable = currStock + currBond + currCash;
  const maxPossibleWithdrawal = currCash + (currStock + currBond) * (1 - TRANSACTION_COST);
  const actualWithdrawal = Math.min(state.spend, maxPossibleWithdrawal);

  let actionLog = "";

  // 4. Strategy Execution
  if (totalAvailable <= 0.01 && actualWithdrawal >= 0) {
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
        // (selling exactly `needed` only delivers needed*(1-cost) < needed).
        const grossSellNeeded = needed / (1 - TRANSACTION_COST);
        const grossSell = Math.min(grossSellNeeded, currStock);
        const netCashReceived = grossSell * (1 - TRANSACTION_COST);

        currStock -= grossSell;
        currCash += netCashReceived;
        refillAmount = netCashReceived;
        fees += (grossSell - netCashReceived);
      }

      // Spend Logic: Always try to spend from Cash first.
      // Track whether a forced stock-sell actually occurred so the action log
      // message is accurate even when cash is exactly drained by normal spending
      // (currCash === actualWithdrawal → post-spend currCash === 0, but no sell).
      let forcedSell = false;
      if (currCash >= actualWithdrawal) {
        currCash -= actualWithdrawal;
      } else {
        // Cash insufficient — forced stock sell to cover shortfall.
        forcedSell = true;
        const shortfall = actualWithdrawal - currCash;
        currCash = 0;

        // We need to generate 'shortfall' net cash.
        // Gross sell needed = shortfall / (1 - cost)
        const grossSellNeeded = shortfall / (1 - TRANSACTION_COST);
        const grossSell = Math.min(grossSellNeeded, currStock);
        const netCashReceived = grossSell * (1 - TRANSACTION_COST);

        currStock -= grossSell;
        fees += (grossSell - netCashReceived);

        if (currStock < 0) currStock = 0;
      }

      if (returns.stock < 0) {
        actionLog = `Market Down ${(returns.stock * 100).toFixed(1)}%.`;
        if (!forcedSell) actionLog += ` Spending from Cash Buffer.`;
        else actionLog += ` Cash Empty! Forced Sell.`;
      } else {
        actionLog = `Market Up ${(returns.stock * 100).toFixed(1)}%.`;
        if (refillAmount > 0) actionLog += ` Refilled Cash ($${Math.round(refillAmount / 1000)}k).`;
      }

    } else {
      // --- FIXED ALLOCATION STRATEGY (5 % Drift-Band Rebalancing) ---
      //
      // Drift Band Logic:
      //   After market returns, measure how far the live equity weight has drifted
      //   from the target. When drift ≤ 5 % (absolute) we fund the withdrawal by
      //   selling proportionally at the current mix — no corrective trades, minimal
      //   transaction cost. When drift > 5 % we execute a full rebalance back to
      //   target, which also disciplines the buy-low/sell-high benefit.
      //
      //   Within-band cost:  actualWithdrawal × TRANSACTION_COST
      //   Outside-band cost: total-trade-volume × TRANSACTION_COST (larger)
      //
      // currCash is 0 for fixed strategies: it is initialised to 0 and never
      // accumulates between years (all proceeds are redeployed into stocks/bonds).
      const preWithdrawalTotal = currStock + currBond + currCash;
      const currentEquityRatio = preWithdrawalTotal > 0.01
        ? currStock / preWithdrawalTotal
        : targetWeights.stock;
      const drift = Math.abs(currentEquityRatio - targetWeights.stock);

      let total = preWithdrawalTotal - actualWithdrawal;

      if (total > 0.01) {
        if (drift > 0.05) {
          // OUTSIDE band: full corrective rebalance back to target weights.
          // tradeAmount covers both funding the withdrawal AND correcting drift.
          const targetStock = total * targetWeights.stock;
          const targetBond  = total * targetWeights.bond;
          const tradeAmount = Math.abs(currStock - targetStock) + Math.abs(currBond - targetBond);
          const rebalancingCost = tradeAmount * TRANSACTION_COST;
          total    -= rebalancingCost;
          fees     += rebalancingCost;
          currStock = total * targetWeights.stock;
          currBond  = total * targetWeights.bond;
          currCash  = 0;
          actionLog = `Rebalanced ${Math.round(targetWeights.stock * 100)}/${Math.round(targetWeights.bond * 100)} (drift ${(drift * 100).toFixed(1)}%).`;
        } else {
          // WITHIN band (≤ 5 %): sell proportionally at the current allocation.
          // Only charge friction on the liquidation required to cover spending.
          const withdrawalCost = actualWithdrawal * TRANSACTION_COST;
          total    -= withdrawalCost;
          fees     += withdrawalCost;
          currStock = total * currentEquityRatio;
          currBond  = total * (1 - currentEquityRatio);
          currCash  = 0;
          actionLog = `Held ${Math.round(currentEquityRatio * 100)}/${Math.round((1 - currentEquityRatio) * 100)} (within band).`;
        }
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
      spend: state.spend,
      // Pass through G-K fields unchanged — mutations live in the calling loop.
      spendMultiplier: state.spendMultiplier,
      iwr: state.iwr,
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
  annualReturns: { stock: number, bond: number, cash: number }[],
  startYear: number   // same value captured by runSimulation for chart year labels
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
    stock: 0, bond: 0, cash: 0, spend: initialSpend,
    spendMultiplier: 1.0,
    iwr: 0,
  };

  if (strategy === 'BUCKET') {
    // Mirror of runSimulation initial state — use grossed-up spend so the
    // initial cash buffer matches what simulateYear targets in year 1.
    const grossedUpInitialSpend = computeFirstYearGrossedUpSpend(initialSpend, totalStartPortfolio, inputs);
    const targetCashBuffer = 2 * Math.max(grossedUpInitialSpend, 0);
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
    // Initialization cost: charge friction on the full round-trip trade volume.
    // Starting state: initialCash (cash) + initialInvestments (stocks, assumed).
    // Target state:   targetStockWeight × total  (stocks)
    //                 targetBondWeight  × total  (bonds, bought from zero)
    //                 0                          (cash all deployed)
    //
    // Trade volume = |stock delta| + |bond delta|
    //   = |initialInvestments − targetStockAmt| + targetBondAmt
    //
    // Previously only the sell side (max-zero stock delta) was charged, so users
    // who started with all cash and needed to buy both stocks and bonds paid $0
    // in friction. Now both buying and selling are priced correctly.
    const targetStockAmt = totalStartPortfolio * targetStockWeight;
    const targetBondAmt = totalStartPortfolio * targetBondWeight;
    const tradeVolume = Math.abs(initialInvestments - targetStockAmt) + targetBondAmt;
    const setupCost = tradeVolume * TRANSACTION_COST;
    const effectiveTotal = totalStartPortfolio - setupCost;
    state.stock = effectiveTotal * targetStockWeight;
    state.bond = effectiveTotal * targetBondWeight;
    state.cash = 0;
  }

  // Tracks the product of (1 + realised_inflation) across all years for precise
  // nominal-dollar reporting.  Using the actual stochastic draws (stored in the
  // returns array) is more accurate than a fixed compound factor.
  let cumulativeInflationFactor = 1.0;

  for (let year = 1; year <= inputs.timeHorizon; year++) {
    // Update spend for the current phase (year is 1-based; convert to 0-based for lookup)
    let baseSpend = getSpendingForYear(year - 1, inputs.spendingPhases);

    // --- RMD & Tax Gross-Up ---
    // 1. RMD: compute IRS-mandated minimum withdrawal for this year.
    const ageThisYear = inputs.currentAge + year;

    // Capture SS/pension income before deducting it from baseSpend so we can
    // report the offset explicitly in the audit row (ssIncome column).
    const ssIncomeThisYear = ageThisYear >= inputs.socialSecurityAge
      ? inputs.socialSecurityIncome * 12
      : 0;

    if (ssIncomeThisYear > 0) baseSpend -= ssIncomeThisYear;

    const totalPreWithdrawal = state.stock + state.bond + state.cash;
    const rmdAmount = computeRMD(totalPreWithdrawal, ageThisYear, inputs.taxDeferredRatio, inputs.birthYear);

    const taxRate    = inputs.withdrawalTaxRate / 100;
    const effTaxRate = taxRate * (inputs.taxDeferredRatio / 100);

    // BUG FIX: Apply the accumulated G-K multiplier BEFORE computing taxOwed so
    // the tax gross-up reflects the actual (already-adjusted) spending need, not
    // the pre-guardrail amount.  (Prior order over-taxed Capital Preservation years.)
    baseSpend *= state.spendMultiplier;

    // 2. Tax gross-up on the G-K-adjusted baseSpend.
    let taxOwed = 0;
    if (baseSpend > 0) {
      const grossBaseSpend = effTaxRate > 0 && effTaxRate < 1 ? baseSpend / (1 - effTaxRate) : baseSpend;
      const taxFromNeeds   = grossBaseSpend - baseSpend;
      const taxFromRMD     = rmdAmount * taxRate;
      taxOwed = Math.max(taxFromNeeds, taxFromRMD);
    } else {
      taxOwed = rmdAmount * taxRate; // SS/pension fully funds spending; RMD still taxable
    }

    state.spend = baseSpend + taxOwed;

    // --- Guyton-Klinger Guardrail Check ---
    // CWR uses totalPreWithdrawal (already computed above) — no duplicate calculation.
    let gkEvent = '';
    const currentWR = totalPreWithdrawal > 0.01 ? state.spend / totalPreWithdrawal : 0;

    if (year === 1) {
      state.iwr = currentWR; // Baseline IWR set in the first retirement year
    } else if (state.iwr > 0.0001) {
      if (currentWR > state.iwr * 1.20) {
        state.spendMultiplier *= 0.90;
        state.spend           *= 0.90;
        gkEvent = 'Capital Preservation Triggered: Withdrawal reduced by 10%.';
      } else if (currentWR < state.iwr * 0.80) {
        state.spendMultiplier *= 1.10;
        state.spend           *= 1.10;
        gkEvent = 'Prosperity Rule: Withdrawal increased by 10%.';
      }
    }

    const startCash  = state.cash;
    const startStock = state.stock;
    const startBond  = state.bond;

    const returns = annualReturns[year - 1];

    // Accumulate stochastic inflation for accurate nominal-dollar conversion.
    cumulativeInflationFactor *= (1 + returns.inflation);

    const outcome = simulateYear(state, returns, inputs, strategy, { stock: targetStockWeight, bond: targetBondWeight });

    // Nominal withdrawal uses the exact cumulative product of stochastic inflation
    // draws (not a fixed-rate approximation) for a precise 1099-R reference figure.
    const nominalWithdrawal = outcome.withdrawal * cumulativeInflationFactor;

    log.push({
      year: startYear + year,
      startCash,
      startStock,
      startBond,
      stockReturn:       returns.stock,
      bondReturn:        returns.bond,
      cashReturn:        returns.cash,
      realizedInflation: returns.inflation,
      growthAmount:      outcome.growth,
      feesAmount:        outcome.fees,
      action:            outcome.actionLog, // strategy-only mechanical action
      gkEvent,                              // G-K event isolated for styled badge rendering
      withdrawal:        outcome.withdrawal,
      taxPaid:           taxOwed,
      endTotal:          outcome.nextState.stock + outcome.nextState.bond + outcome.nextState.cash,
      rmdAmount,
      nominalWithdrawal,
      ssIncome:          ssIncomeThisYear,
      spendMultiplier:   state.spendMultiplier, // current accumulated G-K factor this year
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

  // meanInflation passed to generateAnnualReturns as a decimal.
  // Stochastic inflation is drawn per-year inside that function, so there is no
  // longer a single REAL_ASSUMPTIONS constant — it varies with every draw.
  const meanInflation = inflationRate / 100;

  const allRuns: SimulationRun[] = [];
  // Use Float64Array for column-based storage (Performance Optimization)
  const trajectoryColumns: Float64Array[] = Array(timeHorizon).fill(0).map(() => new Float64Array(NUM_SIMULATIONS));

  let failures = 0;
  let totalAnnualizedVol = 0;

  const initialSpend = getSpendingForYear(0, spendingPhases);

  for (let sim = 0; sim < NUM_SIMULATIONS; sim++) {
    // Initial State
    let state: SimState = {
      stock: 0, bond: 0, cash: 0, spend: initialSpend,
      spendMultiplier: 1.0,
      iwr: 0,
    };

    if (strategy === 'BUCKET') {
      // The cash buffer must cover 2 × grossed-up spend so it matches exactly
      // what simulateYear targets in year 1 (after tax and SS adjustments).
      // Using raw spend here would leave the buffer short by the tax gross-up
      // amount, triggering spurious stock sells in the first simulation year.
      const grossedUpInitialSpend = computeFirstYearGrossedUpSpend(initialSpend, totalStartPortfolio, inputs);
      const targetCashBuffer = 2 * Math.max(grossedUpInitialSpend, 0);
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
      // Initialization cost: symmetric round-trip friction on both buy and sell legs.
      // Trade volume = |stock delta| + bond delta (bonds always bought from zero).
      // Mirrors the identical fix in generateAuditLog — see that block for full derivation.
      const targetStockAmt = totalStartPortfolio * targetStockWeight;
      const targetBondAmt = totalStartPortfolio * targetBondWeight;
      const tradeVolume = Math.abs(initialInvestments - targetStockAmt) + targetBondAmt;
      const setupCost = tradeVolume * TRANSACTION_COST;
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
      let baseSpend = getSpendingForYear(year, spendingPhases);

      // --- RMD & Tax Gross-Up (mirrors generateAuditLog logic exactly) ---
      // year is 0-based here; add 1 to align with the 1-based convention in
      // generateAuditLog so both functions compute the same IRS age for the
      // same retirement year (avoids a 1-year RMD trigger discrepancy).
      const ageThisYear = inputs.currentAge + year + 1;
      
      // Supplemental Income offsets need for portfolio withdrawals
      if (ageThisYear >= inputs.socialSecurityAge) {
        baseSpend -= inputs.socialSecurityIncome * 12;
      }

      const totalPreWithdrawal = state.stock + state.bond + state.cash;
      const rmdThisYear = computeRMD(totalPreWithdrawal, ageThisYear, inputs.taxDeferredRatio, inputs.birthYear);
      // Blended effective tax rate: only the fraction held in tax-deferred accounts
      // is taxable on withdrawal. See generateAuditLog for the identical derivation.
      const taxRate = inputs.withdrawalTaxRate / 100;
      const effTaxRate = taxRate * (inputs.taxDeferredRatio / 100);

      // Apply G-K multiplier BEFORE tax so gross-up is on the adjusted spend amount.
      baseSpend *= state.spendMultiplier;

      let taxOwed = 0;
      if (baseSpend > 0) {
        const grossBaseSpend = effTaxRate > 0 && effTaxRate < 1 ? baseSpend / (1 - effTaxRate) : baseSpend;
        const taxFromNeeds = grossBaseSpend - baseSpend;
        const taxFromRMD = rmdThisYear * taxRate;
        taxOwed = Math.max(taxFromNeeds, taxFromRMD);
      } else {
        taxOwed = rmdThisYear * taxRate;
      }

      state.spend = baseSpend + taxOwed;

      // --- Guyton-Klinger Guardrail Check ---
      // totalPreWithdrawal is already computed above for the RMD calculation.
      // Year 0 establishes the IWR; year 1+ may trigger adjustments.
      const currentWR = totalPreWithdrawal > 0.01 ? state.spend / totalPreWithdrawal : 0;

      if (year === 0) {
        state.iwr = currentWR;
      } else if (state.iwr > 0.0001) {
        if (currentWR > state.iwr * 1.20) {
          state.spendMultiplier *= 0.90;
          state.spend           *= 0.90;
        } else if (currentWR < state.iwr * 0.80) {
          state.spendMultiplier *= 1.10;
          state.spend           *= 1.10;
        }
      }

      // generateAnnualReturns now takes nominal assumptions + mean inflation and
      // produces real returns with per-year stochastic inflation baked in.
      // The cash floor is handled inside the function.
      const returns = generateAnnualReturns(NOMINAL_ASSUMPTIONS, meanInflation);
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
    
    // A run is considered a failure if it drops to $1 or below at ANY point,
    // even if later Social Security deposits technically made the balance positive again.
    const droppedToZero = currentRunTrajectory.some(val => val <= 1);
    if (droppedToZero) failures++;

    let variance = 0;
    if (runPortfolioReturns.length > 1) {
      const meanR = runPortfolioReturns.reduce((a, b) => a + b, 0) / runPortfolioReturns.length;
      // Bessel's correction (N-1) gives an unbiased sample variance estimate.
      variance = runPortfolioReturns.reduce((sq, n) => sq + Math.pow(n - meanR, 2), 0) / (runPortfolioReturns.length - 1);
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

  // Sort columns to find percentiles (much faster than full run sorts per year).
  // NOTE: Float64Array.sort() mutates in-place. This is intentional and safe here
  // because each run's trajectory is stored in a *separate* `currentRunTrajectory`
  // Float64Array (inside `allRuns`). `trajectoryColumns[i]` is a parallel column-
  // major copy used solely for O(N log N) percentile extraction; mutating it does
  // not corrupt the row-major `allRuns[j].trajectory` arrays used by findBestFitRun.
  for (let i = 0; i < timeHorizon; i++) {
    const yearValues = trajectoryColumns[i].sort();
    // Nearest-rank percentile: index = ceil(N × p) − 1 (0-based).
    // Math.floor(N × p) gives index 1000 for p=0.10, N=10000 — that is the
    // 1001st value (10.01th percentile).  Subtracting 1 from the ceiling
    // gives index 999 — exactly the 1000th value (10.00th percentile).
    downturnCurve.push(yearValues[Math.ceil(NUM_SIMULATIONS * 0.10) - 1]);
    belowAverageCurve.push(yearValues[Math.ceil(NUM_SIMULATIONS * 0.25) - 1]);
    averageCurve.push(yearValues[Math.ceil(NUM_SIMULATIONS * 0.50) - 1]);
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
        // Normalize each year's squared error by the target value (+1 guards
        // against division-by-zero at depletion). Without normalization the
        // absolute-dollar scale of late years would dominate the metric,
        // making the selected run match the end well but diverge early on.
        const denom = Math.abs(targetCurve[y]) + 1;
        const diff = (run.trajectory[y] - targetCurve[y]) / denom;
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

  // Pass the same `currentYear` used for chart labels so audit rows and chart
  // x-axis are guaranteed to show identical year values (no separate Date() call).
  const auditLogAverage = generateAuditLog(inputs, strategy, medianRun.annualReturns, currentYear);
  const auditLogBelowAverage = generateAuditLog(inputs, strategy, belowAvgRun.annualReturns, currentYear);
  const auditLogDownturn = generateAuditLog(inputs, strategy, downturnRun.annualReturns, currentYear);

  const finalMedian = medianRun.finalBalance;
  const avgVol = (totalAnnualizedVol / NUM_SIMULATIONS) * 100;

  // Display Allocation Calc
  let dispStock = targetStockWeight;
  let dispBond = targetBondWeight;
  let dispCash = 0;
  if (strategy === 'BUCKET') {
    // Use the same grossed-up initial spend as the simulation initialization so
    // the displayed allocation exactly matches what the engine sets up on day one.
    const rawInitialSpend = getSpendingForYear(0, spendingPhases);
    const grossedUpInitialSpend = computeFirstYearGrossedUpSpend(rawInitialSpend, totalStartPortfolio, inputs);
    const startCash = Math.min(totalStartPortfolio, 2 * Math.max(grossedUpInitialSpend, 0));
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