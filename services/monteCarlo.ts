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

// Guyton-Klinger guardrail bounds.
// The multiplier tracks accumulated G-K adjustments and is clamped to [GK_FLOOR, GK_CEILING].
// Without a floor, consecutive safety fires (every other year) compound to a 65%+ spending
// reduction over 20 years — far beyond what G-K was ever intended to produce.
// 0.85 floor = spending can never drop more than 15% below the phase target.
// 1.25 ceiling = spending can never rise more than 25% above the phase target.
const GK_FLOOR    = 0.85;
const GK_CEILING  = 1.25;

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
  if (birthYear <= 1950) threshold = 72;  // born ≤ 1950: attains 72 before Jan 1 2023 → pre-SECURE 2.0 age-72 rule
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

  const taxRate = inputs.withdrawalTaxRate / 100;
  const effTaxRate = taxRate * (inputs.taxDeferredRatio / 100);

  if (ageAtYear1 >= inputs.socialSecurityAge) {
    // Bug 5 fix: SS income is not 100% tax-free for high-income retirees.
    // Only the after-tax portion of SS offsets the portfolio withdrawal need;
    // the tax on SS benefits (at the user's withdrawalTaxRate) must still come
    // from the portfolio. Equivalent to: baseSpend -= SS * (1 - taxRate).
    baseSpend -= inputs.socialSecurityIncome * 12 * (1 - taxRate);
  }
  const rmdAmount = computeRMD(portfolioBalance, ageAtYear1, inputs.taxDeferredRatio, inputs.birthYear);

  // Mirror the simulation loop's RMD-aware gross-up exactly:
  // if rmdAmount > grossed-up spend → the RMD is the portfolio withdrawal floor;
  // otherwise → the normal gross-up spend is the withdrawal.
  let grossBaseSpend = Math.max(0, baseSpend);
  if (baseSpend > 0) {
    if (effTaxRate > 0 && effTaxRate < 1) {
      grossBaseSpend = baseSpend / (1 - effTaxRate);
    } else if (effTaxRate >= 1) {
      grossBaseSpend = portfolioBalance;
    }
  }

  return rmdAmount > grossBaseSpend ? rmdAmount : grossBaseSpend;
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

let randnCached: number | null = null;
function randn_bm(): number {
  if (randnCached !== null) {
    const val = randnCached;
    randnCached = null;
    return val;
  }
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const mag = Math.sqrt(-2.0 * Math.log(u));
  randnCached = mag * Math.sin(2.0 * Math.PI * v);
  return mag * Math.cos(2.0 * Math.PI * v);
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
): { stock: number; bond: number; cash: number; inflation: number; crashed: boolean } {

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
  let crashed = false;
  if (Math.random() < 0.02) {
    const shock = 0.20 + Math.random() * 0.20; // uniform in [0.20, 0.40]
    stockReturn = (1 + stockReturn) * (1 - shock) - 1;
    crashed = true;
  }

  // Return the realised inflation alongside asset returns so callers can
  // accumulate a precise cumulative inflation factor for nominal-dollar reporting.
  // `crashed` flags jump-diffusion years so the audit table can annotate them.
  return { stock: stockReturn, bond: bondReturn, cash: cashReturn, inflation: annualInflation, crashed };
}

// 3. SIMULATION LOGIC

interface SimulationRun {
  id: number;
  finalBalance: number;
  trajectory: Float64Array; // Memory Optimization
  annualReturns: { stock: number; bond: number; cash: number; inflation: number; crashed: boolean }[];
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
  /** True if a G-K guardrail fired in the immediately preceding year.
   *  Enforces the standard 1-year cooldown: no back-to-back adjustments. */
  gkFiredLastYear: boolean;
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
      //
      // targetBuffer is capped at 50% of the total current portfolio.
      // Without this cap, when a portfolio shrinks close to 2× annual spend the
      // strategy would liquidate 80–100% of stocks to fill the cash bucket,
      // destroying the growth engine and producing misleading "sold gains" log
      // entries when nearly all of what was sold was principal.
      const totalCurrentPortfolio = currStock + currBond + currCash;
      const targetBuffer = Math.min(2 * state.spend, totalCurrentPortfolio * 0.50);
      let refillAmount = 0;
      let refillIncludesPrincipal = false;

      // Rule: If Stocks are UP, sell to refill cash bucket (up to the capped target).
      if (returns.stock > 0 && currStock > 0 && currCash < targetBuffer) {
        const needed = targetBuffer - currCash;
        // Gross-up: sell enough stock so that net proceeds after cost equal exactly `needed`.
        const grossSellNeeded = needed / (1 - TRANSACTION_COST);
        const grossSell = Math.min(grossSellNeeded, currStock);
        const netCashReceived = grossSell * (1 - TRANSACTION_COST);

        // Determine whether the sale dips into principal (not just gains).
        const stockGain = Math.max(0, currStock - state.stock);
        refillIncludesPrincipal = netCashReceived > stockGain;

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
        if (!forcedSell) {
          actionLog = `Market down ${(returns.stock * 100).toFixed(1)}%: Spending from cash to give stocks time to recover.`;
        } else {
          actionLog = `Market down ${(returns.stock * 100).toFixed(1)}%: Cash drained — forced to sell stocks to cover spending.`;
        }
      } else {
        actionLog = `Market up ${(returns.stock * 100).toFixed(1)}%.`;
        if (refillAmount > 0) {
          const refillLabel = refillIncludesPrincipal ? 'stocks' : 'stock gains';
          actionLog += ` Sold ${refillLabel} to refill cash by $${Math.round(refillAmount / 1000)}k (buffer capped at 50% of portfolio).`;
        } else {
          actionLog += ` Cash buffer already full; no selling needed.`;
        }
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
          actionLog = `Mix drifted too far (${(drift * 100).toFixed(1)}%). Rebalanced to ${Math.round(targetWeights.stock * 100)}/${Math.round(targetWeights.bond * 100)} target.`;
        } else {
          // WITHIN band (≤ 5 %): sell proportionally at the current allocation.
          // Only charge friction on the liquidation required to cover spending.
          const withdrawalCost = actualWithdrawal * TRANSACTION_COST;
          total    -= withdrawalCost;
          fees     += withdrawalCost;
          currStock = total * currentEquityRatio;
          currBond  = total * (1 - currentEquityRatio);
          currCash  = 0;
          actionLog = `Mix stayed within 5% limit. Normal withdrawal at ${Math.round(currentEquityRatio * 100)}/${Math.round((1 - currentEquityRatio) * 100)}, without extra rebalancing trades.`;
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
      gkFiredLastYear: state.gkFiredLastYear,
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
  annualReturns: { stock: number; bond: number; cash: number; inflation: number; crashed: boolean }[],
  startYear: number,   // same value captured by runSimulation for chart year labels
  nominalAssumptions: typeof NOMINAL_ASSUMPTIONS = NOMINAL_ASSUMPTIONS // passed from runSimulation to match simulation engine
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
    gkFiredLastYear: false,
  };

  // Bug 3 fix: capture the one-time setup friction so Year 1 of the audit log can
  // surface it as an explicit fee. Without this, the starting balance appears lower
  // than the user's input with no corresponding fees entry — "vanishing money".
  let initialSetupCost = 0;

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
    initialSetupCost = setupCost;
    const effectiveTotal = totalStartPortfolio - setupCost;
    state.stock = effectiveTotal * targetStockWeight;
    state.bond = effectiveTotal * targetBondWeight;
    state.cash = 0;
  }

  // Tracks the product of (1 + realised_inflation) across all years for precise
  // nominal-dollar reporting.  Using the actual stochastic draws (stored in the
  // returns array) is more accurate than a fixed compound factor.
  let cumulativeInflationFactor = 1.0;

  // Track the raw (pre-SS, pre-multiplier) phase spend so we can detect spending
  // phase transitions and reset the G-K IWR baseline. Without this, a planned
  // spending DROP triggers an immediate Prosperity raise (CWR << IWR × 80%), and a
  // planned INCREASE triggers an immediate Safety cut (CWR >> IWR × 120%).
  let prevRawPhaseSpend = initialSpend;

  // Guyton-Klinger requires checking the PRIOR year's TOTAL PORTFOLIO return direction.
  // Safety only fires after a negative year; Prosperity only fires after a positive year.
  // (Guyton 2004 / Klinger 2006: "Capital Preservation Rule applies in years when the
  // prior calendar year portfolio return was negative.")
  // Using stock-only return is incorrect for balanced portfolios: a year with stocks +5%
  // and bonds -15% yields a negative total return (-3% on 60/40) — Safety should fire,
  // but stock-only logic would enable Prosperity instead.
  let prevYearPortfolioReturn = 0;

  // Track when SS income first activates so we can reset the G-K IWR baseline.
  // Without this reset, the first year of SS causes a sharp drop in net portfolio
  // withdrawals → CWR << 0.8 × IWR → Prosperity guardrail fires repeatedly,
  // compounding spending raises up to the 1.25 ceiling purely because SS offset
  // made the CWR look artificially low — not because the portfolio is healthy.
  let prevSsIncomeActive = false;

  for (let year = 1; year <= inputs.timeHorizon; year++) {
    // Update spend for the current phase (year is 1-based; convert to 0-based for lookup)
    let baseSpend = getSpendingForYear(year - 1, inputs.spendingPhases);
    // Capture raw phase spend BEFORE SS / multiplier modifications for phase-change detection.
    const rawPhaseSpend   = baseSpend;
    const phaseChanged    = year > 1 && rawPhaseSpend !== prevRawPhaseSpend;
    prevRawPhaseSpend     = rawPhaseSpend;

    // --- RMD & Tax Gross-Up ---
    // 1. RMD: compute IRS-mandated minimum withdrawal for this year.
    const ageThisYear = inputs.currentAge + year;

    // Capture SS/pension income before deducting it from baseSpend so we can
    // report the offset explicitly in the audit row (ssIncome column).
    const ssIncomeThisYear = ageThisYear >= inputs.socialSecurityAge
      ? inputs.socialSecurityIncome * 12
      : 0;

    // Detect the first year SS income becomes active; treat it as an IWR reset
    // event (same as a spending phase transition) so the G-K baseline reflects
    // the new, lower net withdrawal need rather than the pre-SS portfolio draw.
    const ssIncomeJustActivated = !prevSsIncomeActive && ssIncomeThisYear > 0;
    prevSsIncomeActive = ssIncomeThisYear > 0;
    const isPhaseTransition = phaseChanged || ssIncomeJustActivated;

    const taxRate    = inputs.withdrawalTaxRate / 100;
    const effTaxRate = taxRate * (inputs.taxDeferredRatio / 100);

    if (ssIncomeThisYear > 0) {
      // Bug 5 fix: SS income is not 100% tax-free for high-income retirees.
      // Only the after-tax portion offsets the portfolio withdrawal need; the tax
      // on SS (at withdrawalTaxRate) must still come from the portfolio.
      // Equivalent to: baseSpend -= ssIncomeThisYear * (1 - taxRate).
      baseSpend -= ssIncomeThisYear * (1 - taxRate);
    }

    const totalPreWithdrawal = state.stock + state.bond + state.cash;
    const rmdAmount = computeRMD(totalPreWithdrawal, ageThisYear, inputs.taxDeferredRatio, inputs.birthYear);

    // BUG FIX: Apply the accumulated G-K multiplier BEFORE computing taxOwed so
    // the tax gross-up reflects the actual (already-adjusted) spending need, not
    // the pre-guardrail amount.  (Prior order over-taxed Capital Preservation years.)
    baseSpend *= state.spendMultiplier;

    // 2. RMD-aware gross-up: IRS Pub 590-B requires the full rmdAmount to leave the
    //    tax-deferred account regardless of spending need.  When the RMD exceeds the
    //    grossed-up spending withdrawal it becomes the portfolio withdrawal floor, and
    //    tax is computed on that larger distribution — not just the spending portion.
    let grossBaseSpend = Math.max(0, baseSpend);
    if (baseSpend > 0) {
      if (effTaxRate > 0 && effTaxRate < 1) {
        grossBaseSpend = baseSpend / (1 - effTaxRate);
      } else if (effTaxRate >= 1) {
        grossBaseSpend = totalPreWithdrawal;
      }
    }

    let taxOwed: number;
    if (rmdAmount > grossBaseSpend) {
      // RMD forces a larger distribution than the spending need.
      // Tax is withheld from the RMD distribution itself.
      state.spend = rmdAmount;
      taxOwed     = rmdAmount * taxRate;
    } else {
      // Spending need exceeds RMD — normal tax gross-up path.
      state.spend = grossBaseSpend;
      taxOwed     = grossBaseSpend - Math.max(0, baseSpend);
    }

    // --- Guyton-Klinger Guardrail Check ---
    // CWR uses totalPreWithdrawal (already computed above) — no duplicate calculation.
    //
    // Rules enforced:
    //  • 1-year cooldown: no back-to-back adjustments (prevents every-other-year spiral).
    //  • Floor / ceiling on spendMultiplier [GK_FLOOR, GK_CEILING]: spending can never
    //    drop more than 15% below or rise more than 25% above the phase target.
    //  • IWR resets at spending phase transitions so a planned spending change
    //    (e.g. dropping from $50k to $25k in a later phase) does not immediately
    //    trigger the wrong guardrail against the year-1 baseline.
    let gkEvent = '';
    const currentWR = totalPreWithdrawal > 0.01 ? state.spend / totalPreWithdrawal : 0;

    if (year === 1 || isPhaseTransition) {
      // Year 1 or new spending phase: establish / re-establish the G-K baseline.
      state.iwr             = currentWR;
      state.gkFiredLastYear = false;
    } else if (state.iwr > 0.0001) {
      // Per the original G-K paper (Guyton 2004 / Klinger 2006), Safety fires only when the
      // prior year's portfolio return was negative, and Prosperity only when it was positive.
      if (!state.gkFiredLastYear && currentWR > state.iwr * 1.20 && state.spendMultiplier > GK_FLOOR && prevYearPortfolioReturn < 0) {
        // Safety: portfolio shrinking faster than sustainable — cut spending.
        const newMult    = Math.max(state.spendMultiplier * 0.90, GK_FLOOR);
        const factor     = newMult / state.spendMultiplier; // ≤ 0.90; may be larger if hitting floor
        state.spendMultiplier = newMult;
        state.spend      *= factor;
        // Bug 1 fix: the GK 10% cut must never push spending below the IRS RMD floor.
        // Without this guard, an RMD-spiked CWR triggers Safety, and the 0.90 multiplier
        // then cuts the actual withdrawal below the legal minimum distribution.
        state.spend       = Math.max(state.spend, rmdAmount);
        // Tax formula: if spending ended at the RMD floor (either because RMD was the
        // original floor OR because the 10% cut pushed below the RMD and got clamped
        // back up), the entire distribution is treated as a mandatory pre-tax draw
        // → tax = spend × marginal rate.  Otherwise use the standard gross-up wedge.
        taxOwed = state.spend <= rmdAmount + 1
          ? state.spend * taxRate
          : state.spend - Math.max(0, baseSpend * factor);
        gkEvent = newMult === GK_FLOOR
          ? 'Safety Guardrail (floor): Spending cut reached the 15% maximum reduction — no further cuts will be applied.'
          : 'Safety Guardrail: Gross portfolio withdrawal rate exceeded 120% of your starting rate — portfolio shrinking faster than expected. Spending cut by 10%.';
        state.gkFiredLastYear = true;
      } else if (!state.gkFiredLastYear && currentWR > 0 && currentWR < state.iwr * 0.80 && state.spendMultiplier < GK_CEILING && prevYearPortfolioReturn > 0) {
        // Prosperity: portfolio very healthy — allow a spending raise.
        // Bug 4 fix: guard currentWR > 0 so a depleted portfolio (CWR = 0) cannot
        // trigger an endless chain of 10% raises on non-existent money.
        const newMult    = Math.min(state.spendMultiplier * 1.10, GK_CEILING);
        const factor     = newMult / state.spendMultiplier;
        state.spendMultiplier = newMult;
        state.spend      *= factor;
        taxOwed = rmdAmount > grossBaseSpend
          ? state.spend * taxRate
          : state.spend - Math.max(0, baseSpend * factor);
        gkEvent = newMult === GK_CEILING
          ? 'Prosperity Guardrail (ceiling): Spending raise reached the 25% maximum increase — no further raises will be applied.'
          : 'Prosperity Guardrail: Gross portfolio withdrawal rate dropped below 80% of your starting rate — portfolio is very healthy. Spending raised by 10%.';
        state.gkFiredLastYear = true;
      } else {
        state.gkFiredLastYear = false;
      }
    }

    const startCash  = state.cash;
    const startStock = state.stock;
    const startBond  = state.bond;

    const returns = annualReturns[year - 1];

    // Accumulate stochastic inflation for accurate nominal-dollar conversion.
    cumulativeInflationFactor *= (1 + returns.inflation);

    // nominalAssumptions is forwarded from runSimulation so the audit log uses the
    // same stock return assumption as the 100,000-run simulation (not the hardcoded default).
    void nominalAssumptions; // parameter is not used in simulateYear — it was used by generateAnnualReturns
    // Note: the returns array passed in already encodes the correct distribution drawn
    // by generateAnnualReturns(dynamicAssumptions, ...) in runSimulation, so the audit
    // rows reflect the user's expectedStockReturn automatically via the stored returns.

    const outcome = simulateYear(state, returns, inputs, strategy, { stock: targetStockWeight, bond: targetBondWeight });

    // When the portfolio is nearly depleted, simulateYear caps actualWithdrawal below
    // state.spend. Scale taxOwed proportionally so the audit doesn't show more tax
    // than the fraction of the withdrawal that actually occurred.
    if (state.spend > 0.01 && outcome.withdrawal < state.spend - 0.01) {
      taxOwed *= outcome.withdrawal / state.spend;
    }

    // Nominal withdrawal uses the exact cumulative product of stochastic inflation
    // draws (not a fixed-rate approximation) for a precise 1099-R reference figure.
    const nominalWithdrawal = outcome.withdrawal * cumulativeInflationFactor;

    log.push({
      year: startYear + year,
      startCash,
      // Bug 3 fix: In Year 1, add the setup friction back to startStock so the
      // logged start balance equals the user's original input portfolio. The matching
      // initialSetupCost is added to feesAmount below so the audit math
      // (Start + Growth − Fees − Draw = End) still balances exactly.
      startStock: year === 1 ? startStock + initialSetupCost : startStock,
      startBond,
      stockReturn:       returns.stock,
      bondReturn:        returns.bond,
      cashReturn:        returns.cash,
      realizedInflation: returns.inflation,
      growthAmount:      outcome.growth,
      feesAmount:        outcome.fees + (year === 1 ? initialSetupCost : 0),
      action:            outcome.actionLog, // strategy-only mechanical action
      gkEvent,                              // G-K event isolated for styled badge rendering
      withdrawal:        outcome.withdrawal,
      taxPaid:           taxOwed,
      endTotal:          outcome.nextState.stock + outcome.nextState.bond + outcome.nextState.cash,
      rmdAmount,
      nominalWithdrawal,
      ssIncome:          ssIncomeThisYear,
      spendMultiplier:   state.spendMultiplier, // current accumulated G-K factor this year
      crashed:           returns.crashed,        // jump-diffusion flag for audit annotation
    });

    // Compute total portfolio return for this year so the NEXT year's G-K direction
    // check uses the full portfolio return (stocks + bonds + cash), not just stocks.
    // Formula: (end balance + withdrawal) / start balance − 1  (total-return convention).
    const auditStartBalance = startCash + startStock + startBond; // actual values, pre-display-adjustment
    if (auditStartBalance > 0.01) {
      const auditEndBalance = outcome.nextState.stock + outcome.nextState.bond + outcome.nextState.cash;
      prevYearPortfolioReturn = (auditEndBalance + outcome.withdrawal) / auditStartBalance - 1;
    }

    state = outcome.nextState;
  }
  return log;
};

// 4. MAIN EXPORT

export const runSimulation = (
  inputs: SimulationInputs,
  strategy: StrategyType
): SimulationResult => {
  // Reset Box-Muller cache so a leftover value from a prior run can't
  // bleed into the first sample of this run.
  randnCached = null;

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

  const dynamicAssumptions = {
    ...NOMINAL_ASSUMPTIONS,
    STOCK: { ...NOMINAL_ASSUMPTIONS.STOCK, mean: inputs.expectedStockReturn / 100 }
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
      stock: 0, bond: 0, cash: 0, spend: initialSpend,
      spendMultiplier: 1.0,
      iwr: 0,
      gkFiredLastYear: false,
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

    const currentRunReturns: { stock: number; bond: number; cash: number; inflation: number; crashed: boolean }[] = [];
    // Store local trajectory for this run in a typed array
    const currentRunTrajectory = new Float64Array(timeHorizon);
    const runPortfolioReturns: number[] = [];

    // Phase-transition tracking: mirrors generateAuditLog.
    let prevRawPhaseSpend = initialSpend;

    let prevBalance = totalStartPortfolio;
    // Track the prior year's TOTAL portfolio return for G-K direction checks.
    // Using stock-only return (previous approach) gives wrong results when bonds
    // move against stocks, e.g. stocks +5% / bonds -15% on 60/40 = -3% portfolio.
    let prevYearPortfolioReturn = 0;
    let prevSsIncomeActive = false;

    for (let year = 0; year < timeHorizon; year++) {
      // Update spend for the current phase before simulateYear consumes state.spend
      let baseSpend = getSpendingForYear(year, spendingPhases);
      // Detect spending phase transitions (mirrors generateAuditLog logic).
      const rawPhaseSpend  = baseSpend;
      const phaseChanged   = year > 0 && rawPhaseSpend !== prevRawPhaseSpend;
      prevRawPhaseSpend    = rawPhaseSpend;

      // --- RMD & Tax Gross-Up (mirrors generateAuditLog logic exactly) ---
      // year is 0-based here; add 1 to align with the 1-based convention in
      // generateAuditLog so both functions compute the same IRS age for the
      // same retirement year (avoids a 1-year RMD trigger discrepancy).
      const ageThisYear = inputs.currentAge + year + 1;

      // Supplemental Income offsets need for portfolio withdrawals.
      // Also detect first SS activation for G-K IWR baseline reset (mirrors generateAuditLog).
      const ssActive = ageThisYear >= inputs.socialSecurityAge;
      const ssIncomeJustActivated = !prevSsIncomeActive && ssActive;
      prevSsIncomeActive = ssActive;
      const isPhaseTransition = phaseChanged || ssIncomeJustActivated;

      // Blended effective tax rate: only the fraction held in tax-deferred accounts
      // is taxable on withdrawal. See generateAuditLog for the identical derivation.
      const taxRate = inputs.withdrawalTaxRate / 100;
      const effTaxRate = taxRate * (inputs.taxDeferredRatio / 100);

      if (ssActive) {
        // Bug 5 fix: SS income is not 100% tax-free for high-income retirees.
        // Only the after-tax portion offsets the portfolio withdrawal need; the tax
        // on SS (at withdrawalTaxRate) must still come from the portfolio.
        baseSpend -= inputs.socialSecurityIncome * 12 * (1 - taxRate);
      }

      const totalPreWithdrawal = state.stock + state.bond + state.cash;
      const rmdThisYear = computeRMD(totalPreWithdrawal, ageThisYear, inputs.taxDeferredRatio, inputs.birthYear);

      // Apply G-K multiplier BEFORE tax so gross-up is on the adjusted spend amount.
      baseSpend *= state.spendMultiplier;

      // Mirrors generateAuditLog: RMD is a hard floor on the portfolio withdrawal.
      let grossBaseSpend = Math.max(0, baseSpend);
      if (baseSpend > 0) {
        if (effTaxRate > 0 && effTaxRate < 1) {
          grossBaseSpend = baseSpend / (1 - effTaxRate);
        } else if (effTaxRate >= 1) {
          grossBaseSpend = totalPreWithdrawal;
        }
      }

      let taxOwed: number;
      if (rmdThisYear > grossBaseSpend) {
        state.spend = rmdThisYear;
        taxOwed     = rmdThisYear * taxRate;
      } else {
        state.spend = grossBaseSpend;
        taxOwed     = grossBaseSpend - Math.max(0, baseSpend);
      }

      // --- Guyton-Klinger Guardrail Check ---
      // Mirrors generateAuditLog exactly: cooldown + floor/ceiling + phase-transition reset.
      const currentWR = totalPreWithdrawal > 0.01 ? state.spend / totalPreWithdrawal : 0;

      if (year === 0 || isPhaseTransition) {
        state.iwr             = currentWR;
        state.gkFiredLastYear = false;
      } else if (state.iwr > 0.0001) {
        if (!state.gkFiredLastYear && currentWR > state.iwr * 1.20 && state.spendMultiplier > GK_FLOOR && prevYearPortfolioReturn < 0) {
          const newMult         = Math.max(state.spendMultiplier * 0.90, GK_FLOOR);
          const factor          = newMult / state.spendMultiplier;
          state.spendMultiplier = newMult;
          state.spend          *= factor;
          // Bug 1 fix: never cut spending below the IRS RMD floor.
          state.spend           = Math.max(state.spend, rmdThisYear);
          // Tax formula: if spending is at the RMD floor (original RMD floor or clamped
          // back up after the 10% cut), treat the full distribution as taxable.
          taxOwed = state.spend <= rmdThisYear + 1
            ? state.spend * taxRate
            : state.spend - Math.max(0, baseSpend * factor);
          state.gkFiredLastYear = true;
        } else if (!state.gkFiredLastYear && currentWR > 0 && currentWR < state.iwr * 0.80 && state.spendMultiplier < GK_CEILING && prevYearPortfolioReturn > 0) {
          // Bug 4 fix: currentWR > 0 prevents a depleted portfolio from triggering
          // an endless loop of 10% raises (CWR = 0 always satisfies < 0.80 × IWR).
          const newMult         = Math.min(state.spendMultiplier * 1.10, GK_CEILING);
          const factor          = newMult / state.spendMultiplier;
          state.spendMultiplier = newMult;
          state.spend          *= factor;
          taxOwed = rmdThisYear > grossBaseSpend
            ? state.spend * taxRate
            : state.spend - Math.max(0, baseSpend * factor);
          state.gkFiredLastYear = true;
        } else {
          state.gkFiredLastYear = false;
        }
      }

      // generateAnnualReturns now takes nominal assumptions + mean inflation and
      // produces real returns with per-year stochastic inflation baked in.
      // The cash floor is handled inside the function.
      const returns = generateAnnualReturns(dynamicAssumptions, meanInflation);
      currentRunReturns.push(returns);

      const outcome = simulateYear(state, returns, inputs, strategy, { stock: targetStockWeight, bond: targetBondWeight });

      state = outcome.nextState;

      let totalPortfolio = state.stock + state.bond + state.cash;
      if (totalPortfolio < 0) totalPortfolio = 0;

      if (prevBalance > 0.01) {
        const performance = ((totalPortfolio + outcome.withdrawal) / prevBalance) - 1;
        runPortfolioReturns.push(performance);
        // Store for the next year's G-K direction check (uses total portfolio return,
        // not stock-only, to correctly gate Safety/Prosperity on balanced portfolios).
        prevYearPortfolioReturn = performance;
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
    // Accumulate variance (not stdDev) so we can take a single sqrt after all runs.
    // Averaging stdDev per-run then sqrt-ing would give a biased estimator due to
    // Jensen's inequality: E[sqrt(X)] < sqrt(E[X]). Averaging variance first is correct.
    totalAnnualizedVol += variance;

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
    // Use user-configured percentiles (clamped to valid 1–99 range).
    const pDown  = Math.max(0.01, Math.min(0.99, inputs.percentileDownturn      / 100));
    const pBelow = Math.max(0.01, Math.min(0.99, inputs.percentileBelowAverage  / 100));
    const pAvg   = Math.max(0.01, Math.min(0.99, inputs.percentileAverage       / 100));
    downturnCurve.push(yearValues[Math.ceil(NUM_SIMULATIONS * pDown)  - 1]);
    belowAverageCurve.push(yearValues[Math.ceil(NUM_SIMULATIONS * pBelow) - 1]);
    averageCurve.push(yearValues[Math.ceil(NUM_SIMULATIONS * pAvg)   - 1]);
  }

  // Map $0 trajectories to null so Recharts renders a gap at depletion
  // (connectNulls={false}) instead of a misleading flatline at $0.
  // The YearResult type uses `number | null` precisely for this purpose.
  const toNullable = (v: number): number | null => v <= 0 ? null : v;

  const chartData: YearResult[] = averageCurve.map((val, idx) => ({
    year: currentYear + idx + 1,
    average:      toNullable(val),
    belowAverage: toNullable(belowAverageCurve[idx]),
    downturn:     toNullable(downturnCurve[idx]),
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

  // Pass `dynamicAssumptions` so the audit log uses the same stock return distribution
  // as the 100,000-run simulation (fixing the hardcoded 8.5% default bug).
  // The stored annualReturns arrays were drawn using dynamicAssumptions in runSimulation,
  // so audit rows already reflect the user's expectedStockReturn via the recorded draws.
  const auditLogAverage = generateAuditLog(inputs, strategy, medianRun.annualReturns, currentYear, dynamicAssumptions);
  const auditLogBelowAverage = generateAuditLog(inputs, strategy, belowAvgRun.annualReturns, currentYear, dynamicAssumptions);
  const auditLogDownturn = generateAuditLog(inputs, strategy, downturnRun.annualReturns, currentYear, dynamicAssumptions);

  const finalMedian = medianRun.finalBalance;
  // Take sqrt of the average variance across all runs — correct pooled stdDev estimator.
  // (Previously averaged per-run stdDevs which underestimates due to Jensen's inequality.)
  const avgVol = Math.sqrt(totalAnnualizedVol / NUM_SIMULATIONS) * 100;

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