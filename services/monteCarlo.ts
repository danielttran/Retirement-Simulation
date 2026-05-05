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

// Guyton-Klinger guardrail adjustments are strictly temporary (lasting 1 year).
// Therefore, the multiplier only ever reaches 0.90 (Safety) or 1.10 (Prosperity)
// and never compounds, negating the need for historical floors/ceilings.

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

// ---------------------------------------------------------------------------
// SEPP — IRS Single Life Expectancy Table I (2022 update, Pub. 590-B)
// Used for Rule 72(t) Fixed-Amortization withdrawals. Covers typical early-
// retirement claim ages (45–60). For ages outside this range we extrapolate:
// younger → assume same as 45; older falls back to standard RMD logic anyway
// since SEPP only applies before 59½.
// ---------------------------------------------------------------------------
const SINGLE_LIFE_EXP: Readonly<Record<number, number>> = {
  45: 41.0, 46: 40.0, 47: 39.0, 48: 38.1, 49: 37.1,
  50: 36.2, 51: 35.3, 52: 34.3, 53: 33.4, 54: 32.5,
  55: 31.6, 56: 30.6, 57: 29.8, 58: 28.9, 59: 27.9,
};

/**
 * IRS Rule 72(t) Fixed-Amortization SEPP cap.
 * Formula: PMT = PV × r / (1 − (1+r)^−n)  (standard amortization).
 * Returns 0 for ages ≥ 59½ (rule no longer applies — normal withdrawals allowed).
 *
 * @param totalRetirementBalance Combined Traditional + Roth balance at year start.
 * @param age                    Age at start of this simulation year.
 * @param seppRatePct            Interest rate (capped at 120% AFR by IRS).
 */
function computeSEPPCap(totalRetirementBalance: number, age: number, seppRatePct: number): number {
  if (age >= 59.5 || totalRetirementBalance <= 0) return 0;
  const n = SINGLE_LIFE_EXP[Math.min(59, Math.max(45, Math.floor(age)))] ?? 36.2;
  const r = seppRatePct / 100;
  if (r <= 0) return totalRetirementBalance / n;
  return totalRetirementBalance * (r / (1 - Math.pow(1 + r, -n)));
}

/**
 * Healthcare expense add-on (real / today's $). Returns 0 when disabled.
 * Pre-65: ~$8k/yr (private insurance / ACA marketplace bridge).
 * Post-65: ~$7k/yr (Medicare Part B+D premiums + supplemental + OOP).
 * Grows at ~2.5%/yr in real terms (medical CPI runs ~2.5% above general CPI).
 */
function getHealthcareSpend(age: number, include: boolean, yearIdx: number): number {
  if (!include) return 0;
  const base = age < 65 ? 8000 : 7000;
  return base * Math.pow(1.025, Math.max(0, yearIdx));
}

/**
 * 10% IRS early-withdrawal penalty for retirement-account distributions before
 * age 59½. Applied to the Traditional (taxable) portion of the withdrawal that
 * exceeds the SEPP cap when SEPP is active, or the entire Trad portion when
 * SEPP is not used. Roth contributions are penalty-free regardless and are
 * approximated as fully sheltered. Returns 0 for ages ≥ 59½.
 */
function computeEarlyPenalty(
  grossWithdrawal: number,
  age: number,
  inputs: SimulationInputs,
  seppCap: number
): number {
  if (age >= 59.5 || grossWithdrawal <= 0 || inputs.taxDeferredRatio <= 0) return 0;
  const tradPortion = grossWithdrawal * (inputs.taxDeferredRatio / 100);
  const shielded = inputs.useSEPP ? Math.min(seppCap, tradPortion) : 0;
  const exposed = Math.max(0, tradPortion - shielded);
  return exposed * 0.10;
}

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
  let baseSpend = rawSpend + getHealthcareSpend(ageAtYear1, inputs.includeHealthcare, 0);

  const taxRate = inputs.withdrawalTaxRate / 100;
  const effTaxRate = taxRate * (inputs.taxDeferredRatio / 100);

  if (ageAtYear1 >= inputs.socialSecurityAge) {
    // 85% rule: SS income is not 100% tax-free for high-income retirees.
    // Under IRS rules, up to 85% of Social Security benefits can be taxed.
    // We apply the withdrawal tax rate to 85% of the SS income.
    baseSpend -= inputs.socialSecurityIncome * 12 * (1 - taxRate * 0.85);
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

/**
 * Computes the day-0 portfolio state after strategy setup trades and friction.
 * Shared by runSimulation and generateAuditLog to keep initialization math identical.
 */
function initializeStartingState(
  inputs: SimulationInputs,
  strategy: StrategyType,
  targetStockWeight: number,
  targetBondWeight: number,
  targetCashWeight: number,
  initialSpend: number
): { state: SimState; initialSetupCost: number } {
  const { initialCash, initialInvestments } = inputs;
  const totalStartPortfolio = initialCash + initialInvestments;
  const state: SimState = {
    stock: 0, bond: 0, cash: 0, spend: initialSpend,
    spendMultiplier: 1.0,
    iwr: 0,
    gkFiredLastYear: false,
    gkAdjustmentYear: null,
  };
  let initialSetupCost = 0;

  if (strategy === 'BUCKET') {
    const grossedUpInitialSpend = computeFirstYearGrossedUpSpend(initialSpend, totalStartPortfolio, inputs);
    const targetCashBuffer = Math.min(2 * Math.max(grossedUpInitialSpend, 0), totalStartPortfolio * 0.50);
    if (initialCash >= targetCashBuffer) {
      state.cash = targetCashBuffer;
      state.stock = totalStartPortfolio - targetCashBuffer;
    } else {
      const cashNeeded = targetCashBuffer - initialCash;
      const grossSellNeeded = cashNeeded / (1 - TRANSACTION_COST);
      const grossSell = Math.min(grossSellNeeded, initialInvestments);
      state.cash = initialCash + grossSell * (1 - TRANSACTION_COST);
      state.stock = initialInvestments - grossSell;
      initialSetupCost = grossSell * TRANSACTION_COST;
    }
    state.bond = 0;
  } else {
    // Fixed-mix setup starts from: stock=initialInvestments, bond=0, cash=initialCash.
    // Transaction friction is applied on SELL orders only (same convention as BUCKET).
    //
    // When stock is overweight, solve sell volume exactly so post-cost stock dollars
    // match the target weight of the post-cost total:
    //   initialInvestments - x = w_s * (totalStartPortfolio - c * x)
    // where x is gross stock sold and c is TRANSACTION_COST.
    // This avoids tiny but compounding initialization drift from approximating
    // setup cost as c * (initialInvestments - w_s * totalStartPortfolio).
    const targetStockAmtPreCost = totalStartPortfolio * targetStockWeight;
    const denominator = 1 - (targetStockWeight * TRANSACTION_COST);
    const stockToSell = initialInvestments > targetStockAmtPreCost && denominator > 0
      ? (initialInvestments - targetStockAmtPreCost) / denominator
      : 0;
    initialSetupCost = stockToSell * TRANSACTION_COST;
    const effectiveTotal = Math.max(0, totalStartPortfolio - initialSetupCost);

    // With stock overweight, keep the mechanically correct post-sale stock dollars.
    // With stock underweight, no sell-side friction is needed and we can allocate
    // exactly at target by deploying existing cash into stock/bonds.
    state.stock = stockToSell > 0
      ? Math.max(0, initialInvestments - stockToSell)
      : effectiveTotal * targetStockWeight;
    if (strategy === 'CUSTOM' && targetCashWeight > 0) {
      state.stock = effectiveTotal * targetStockWeight;
      state.bond = effectiveTotal * targetBondWeight;
      state.cash = effectiveTotal * targetCashWeight;
    } else {
      state.bond = Math.max(0, effectiveTotal - state.stock);
      state.cash = 0;
    }
  }

  return { state, initialSetupCost };
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
  const annualInflation = Math.max(meanInflation + inflationStdDev * inflationZ, -0.05);
  const inflationDivisor = 1 + annualInflation;

  // --- Step 4: Per-year nominal → real conversion ---
  // Real return mean:  (1 + nomMean) / (1 + inflation) − 1
  // Real return stdDev: nomStd / (1 + inflation)  [variance-scaling property]
  const toReal = (nomMean: number, nomStd: number) => ({
    mean: (1 + nomMean) / inflationDivisor - 1,
    stdDev: nomStd / inflationDivisor,
  });
  const sReal = toReal(nominalAssumptions.STOCK.mean, nominalAssumptions.STOCK.stdDev);
  const bReal = toReal(nominalAssumptions.BOND.mean, nominalAssumptions.BOND.stdDev);
  const cReal = toReal(nominalAssumptions.CASH.mean, nominalAssumptions.CASH.stdDev);

  // --- Step 5: Log-normal moment matching (unchanged from original) ---
  // Converts arithmetic mean / stdDev to log-normal parameters (μ_log, σ_log)
  // via the standard φ = √(σ² + μ²) shorthand.
  // Clamp μ > 0 to avoid NaN when real return mean approaches −1.
  const getLogParams = (arithMean: number, arithStd: number) => {
    const term = Math.max(1 + arithMean, 0.0001);
    const phi = Math.sqrt(arithStd * arithStd + term * term);
    const mu_log = Math.log(term * term / phi);
    const sigma_log = Math.sqrt(Math.log(phi * phi / (term * term)));
    return { mu_log, sigma_log };
  };

  const sP = getLogParams(sReal.mean, sReal.stdDev);
  const bP = getLogParams(bReal.mean, bReal.stdDev);
  const cP = getLogParams(cReal.mean, cReal.stdDev);

  // --- Step 6: Draw log-normal returns ---
  let stockReturn = Math.exp(sP.mu_log + sP.sigma_log * Z_corr[0]) - 1;
  const bondReturn = Math.exp(bP.mu_log + bP.sigma_log * Z_corr[1]) - 1;

  // Cash floor: 0 % nominal → real floor = −inflation / (1 + inflation)
  const minRealCash = -annualInflation / inflationDivisor;
  const cashReturn = Math.max(
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
  /** Guyton-Klinger spend-adjustment factor. Applies for exactly one year, then resets to 1.0. */
  spendMultiplier: number;
  /** Initial Withdrawal Rate — set in year 0 as the baseline for G-K guardrail comparisons. */
  iwr: number;
  /** True if a G-K guardrail fired in the immediately preceding year.
   *  Enforces the standard 1-year cooldown: no back-to-back adjustments. */
  gkFiredLastYear: boolean;
  /** Tracks when the last adjustment occurred to force a 1.0 reset the following year. */
  gkAdjustmentYear: number | null;
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
  targetWeights: { stock: number, bond: number, cash: number }
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
  const cashFee = grossCash * feeRate;

  let currStock = grossStock - stockFee;
  let currBond = grossBond - bondFee;
  let currCash = grossCash - cashFee;

  let fees = stockFee + bondFee + cashFee;

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
          const wasCapped = targetBuffer === totalCurrentPortfolio * 0.50;
          const capText = wasCapped ? ' (buffer capped at 50% of portfolio)' : '';
          actionLog += ` Sold ${refillLabel} to refill cash by $${Math.round(refillAmount / 1000)}k${capText}.`;
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
      //   Within-band cost: sell-side gross-up needed to net the withdrawal.
      //   Outside-band cost: withdrawal sell-side gross-up + sell-side rebalance volume.
      //
      // currCash is 0 for fixed strategies: it is initialised to 0 and never
      // accumulates between years (all proceeds are redeployed into stocks/bonds).
      const preWithdrawalTotal = currStock + currBond + currCash;
      const hasTargetCash = strategy === 'CUSTOM' && targetWeights.cash > 0;
      const currentStockRatio = preWithdrawalTotal > 0.01 ? currStock / preWithdrawalTotal : targetWeights.stock;
      const currentBondRatio = preWithdrawalTotal > 0.01 ? currBond / preWithdrawalTotal : targetWeights.bond;
      const currentCashRatio = preWithdrawalTotal > 0.01 ? currCash / preWithdrawalTotal : targetWeights.cash;
      const drift = hasTargetCash
        ? Math.max(
          Math.abs(currentStockRatio - targetWeights.stock),
          Math.abs(currentBondRatio - targetWeights.bond),
          Math.abs(currentCashRatio - targetWeights.cash)
        )
        : Math.abs(currentStockRatio - targetWeights.stock);

      let total = preWithdrawalTotal - actualWithdrawal;

      if (total > 0.01) {
        if (drift > 0.05) {
          // OUTSIDE band: full corrective rebalance back to target weights.
          // Cost model: charge friction on SELL orders only (consistent with BUCKET).
          // 1) Fund withdrawal from invested assets (no persistent cash sleeve here).
          // 2) Rebalance remaining holdings back to target, charging sell-side friction.
          const investedTotal = currStock + currBond;
          const investedShare = preWithdrawalTotal > 0 ? investedTotal / preWithdrawalTotal : 0;
          const investedNetWithdrawal = actualWithdrawal * investedShare;
          const withdrawalSellCost = investedNetWithdrawal > 0
            ? investedNetWithdrawal * (TRANSACTION_COST / (1 - TRANSACTION_COST))
            : 0;
          const grossWithdrawalLiquidation = investedNetWithdrawal + withdrawalSellCost;
          total -= withdrawalSellCost;
          fees += withdrawalSellCost;
          if (total <= 0.01) {
            currStock = 0; currBond = 0; currCash = 0;
            actionLog = "Portfolio Depleted.";
          } else {
            // Post-withdrawal holdings before rebalance (proportional gross liquidation,
            // including the sell-side friction needed to net the withdrawal).
            const stockShareOfInvested = investedTotal > 0 ? currStock / investedTotal : targetWeights.stock;
            const withdrawalFromStock = grossWithdrawalLiquidation * stockShareOfInvested;
            const withdrawalFromBond = grossWithdrawalLiquidation * (1 - stockShareOfInvested);
            const postWithdrawalStock = Math.max(0, currStock - withdrawalFromStock);
            const postWithdrawalBond = Math.max(0, currBond - withdrawalFromBond);

            const targetStock = total * targetWeights.stock;
            const targetBond = total * targetWeights.bond;
            const targetCash = total * targetWeights.cash;
            const stockSellForRebalance = Math.max(0, postWithdrawalStock - targetStock);
            const bondSellForRebalance = Math.max(0, postWithdrawalBond - targetBond);
            const rebalancingSellVolume = stockSellForRebalance + bondSellForRebalance;
            const rebalancingCost = rebalancingSellVolume * TRANSACTION_COST;
            total -= rebalancingCost;
            fees += rebalancingCost;
            total = Math.max(0, total);
            currStock = total * targetWeights.stock;
            currBond = total * targetWeights.bond;
            currCash = total * targetWeights.cash;
            const targetLabel = `${Math.round(targetWeights.stock * 100)}/${Math.round(targetWeights.bond * 100)}${hasTargetCash ? `/${Math.round(targetWeights.cash * 100)}` : ''}`;
            actionLog = `Mix drifted too far (${(drift * 100).toFixed(1)}%). Rebalanced to ${targetLabel} target.`;
          }
        } else {
          // WITHIN band (≤ 5 %): sell proportionally at the current allocation.
          // Only charge friction on the liquidation required to cover spending.
          const investedTotal = currStock + currBond;
          const investedShare = preWithdrawalTotal > 0 ? investedTotal / preWithdrawalTotal : 0;
          const investedNetWithdrawal = actualWithdrawal * investedShare;
          const withdrawalCost = investedNetWithdrawal > 0
            ? investedNetWithdrawal * (TRANSACTION_COST / (1 - TRANSACTION_COST))
            : 0;
          total -= withdrawalCost;
          fees += withdrawalCost;
          total = Math.max(0, total);
          currStock = total * currentStockRatio;
          currBond = total * currentBondRatio;
          currCash = total * currentCashRatio;
          const mixLabel = `${Math.round(currentStockRatio * 100)}/${Math.round(currentBondRatio * 100)}${hasTargetCash ? `/${Math.round(currentCashRatio * 100)}` : ''}`;
          actionLog = `Mix stayed within 5% limit. Normal withdrawal at ${mixLabel}, without extra rebalancing trades.`;
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
      gkAdjustmentYear: state.gkAdjustmentYear,
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
  const { initialCash, initialInvestments, spendingPhases } = inputs;
  const totalStartPortfolio = initialCash + initialInvestments;

  let targetStockWeight = 0;
  let targetBondWeight = 0;
  let targetCashWeight = 0;
  if (strategy === 'CONSERVATIVE') { targetBondWeight = 0.40; targetStockWeight = 0.60; }
  else if (strategy === 'AGGRESSIVE') { targetBondWeight = 0.30; targetStockWeight = 0.70; }
  else if (strategy === 'CUSTOM') {
    targetStockWeight = inputs.customStockAllocation / 100;
    targetCashWeight = inputs.customCashAllocation / 100;
    targetBondWeight = Math.max(0, 1.0 - targetStockWeight - targetCashWeight);
  }

  const initialSpend = getSpendingForYear(0, spendingPhases);
  const initialized = initializeStartingState(inputs, strategy, targetStockWeight, targetBondWeight, targetCashWeight, initialSpend);
  let state = initialized.state;
  // capture the one-time setup friction so Year 1 of the audit log can
  // surface it as an explicit fee. Without this, the starting balance appears lower
  // than the user's input with no corresponding fees entry — "vanishing money".
  const initialSetupCost = initialized.initialSetupCost;

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

  // SEPP / Rule 72(t) Fixed-Amortization: the dollar amount is locked at plan
  // inception (year 0) and held constant until age 59½ — IRS rules require that
  // the chosen Method (Amortization, Annuitization, or RMD) produce a fixed
  // payment for the duration. Recomputing each year against the live balance
  // would let the cap float with stochastic returns, contradicting the rule.
  // We compute it once here from the post-setup Trad + Roth balance.
  const initialRetirementBalance = (state.stock + state.bond + state.cash)
    * ((inputs.taxDeferredRatio + inputs.rothRatio) / 100);
  const seppCapLocked = computeSEPPCap(initialRetirementBalance, inputs.currentAge, inputs.seppRate);

  for (let year = 1; year <= inputs.timeHorizon; year++) {
    // Update spend for the current phase (year is 1-based; convert to 0-based for lookup)
    let baseSpend = getSpendingForYear(year - 1, inputs.spendingPhases);
    // Capture raw phase spend BEFORE SS / multiplier modifications for phase-change detection.
    const rawPhaseSpend = baseSpend;
    const phaseChanged = year > 1 && rawPhaseSpend !== prevRawPhaseSpend;
    prevRawPhaseSpend = rawPhaseSpend;

    // --- RMD & Tax Gross-Up ---
    // 1. RMD: compute IRS-mandated minimum withdrawal for this year.
    const ageThisYear = inputs.currentAge + year;

    // Healthcare add-on: applied AFTER phase-change detection so it doesn't trip
    // false G-K phase resets, but BEFORE SS offset / tax gross-up so it's properly
    // taxed and grossed up like any other real spending.
    const healthcareSpend = getHealthcareSpend(ageThisYear, inputs.includeHealthcare, year - 1);
    baseSpend += healthcareSpend;

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

    // Reset the Guyton-Klinger penalty/bonus when transitioning to a new
    // voluntary spending phase or when Social Security activates. Carrying forward
    // historical adjustments penalizes the new planned budget.
    if (isPhaseTransition) {
      state.spendMultiplier = 1.0;
      state.gkAdjustmentYear = null;
    }

    // After exactly 1 year of adjustment, force multiplier back to 1.0
    if (state.gkAdjustmentYear !== null && year - state.gkAdjustmentYear === 1) {
      state.spendMultiplier = 1.0;
    }

    const taxRate = inputs.withdrawalTaxRate / 100;
    const effTaxRate = taxRate * (inputs.taxDeferredRatio / 100);

    if (ssIncomeThisYear > 0) {
      // 85% rule: SS income is not 100% tax-free for high-income retirees.
      // Under IRS rules, up to 85% of Social Security benefits can be taxed.
      baseSpend -= ssIncomeThisYear * (1 - taxRate * 0.85);
    }

    const totalPreWithdrawal = state.stock + state.bond + state.cash;
    const rmdAmount = computeRMD(totalPreWithdrawal, ageThisYear, inputs.taxDeferredRatio, inputs.birthYear);

    // Apply the accumulated G-K multiplier BEFORE computing taxOwed so
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
      taxOwed = rmdAmount * taxRate;
    } else {
      // Spending need exceeds RMD — normal tax gross-up path.
      state.spend = grossBaseSpend;
      taxOwed = grossBaseSpend - Math.max(0, baseSpend);
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
      state.iwr = currentWR;
      state.gkFiredLastYear = false;
      state.gkAdjustmentYear = null;
    } else if (state.gkAdjustmentYear !== null && year - state.gkAdjustmentYear === 1) {
      // Adjustment year ended: re-baseline IWR and enforce 1-year cooldown
      state.iwr = currentWR;
      state.gkFiredLastYear = false;
      gkEvent = 'Guardrail Reset: Adjustment period ended. Spending and baseline reset to normal.';
    } else if (state.iwr > 0.0001) {
      // Per the original G-K paper (Guyton 2004 / Klinger 2006), Safety fires only when the
      // prior year's portfolio return was negative, and Prosperity only when it was positive.
      if (!state.gkFiredLastYear && currentWR > state.iwr * 1.20 && prevYearPortfolioReturn < 0) {
        // Safety: portfolio shrinking faster than sustainable — cut spending.
        const newMult = state.spendMultiplier * 0.90;
        const factor = newMult / state.spendMultiplier; // 0.90
        state.spendMultiplier = newMult;
        state.spend *= factor;
        // the GK 10% cut must never push spending below the IRS RMD floor.
        // Without this guard, an RMD-spiked CWR triggers Safety, and the 0.90 multiplier
        // then cuts the actual withdrawal below the legal minimum distribution.
        state.spend = Math.max(state.spend, rmdAmount);
        // Tax formula: if spending ended at the RMD floor (either because RMD was the
        // original floor OR because the 10% cut pushed below the RMD and got clamped
        // back up), the entire distribution is treated as a mandatory pre-tax draw
        // → tax = spend × marginal rate.  Otherwise use the standard gross-up wedge.
        taxOwed = state.spend <= rmdAmount + 1
          ? state.spend * taxRate
          : state.spend - Math.max(0, baseSpend * factor);
        gkEvent = 'Safety Guardrail: Gross portfolio withdrawal rate exceeded 120% of your starting rate. Spending temporarily cut by 10%.';
        state.gkFiredLastYear = true;
        state.gkAdjustmentYear = year;
      } else if (!state.gkFiredLastYear && currentWR > 0 && currentWR < state.iwr * 0.80 && prevYearPortfolioReturn > 0) {
        // Prosperity: portfolio very healthy — allow a spending raise.
        // guard currentWR > 0 so a depleted portfolio (CWR = 0) cannot
        // trigger an endless chain of 10% raises on non-existent money.
        const newMult = state.spendMultiplier * 1.10;
        const factor = newMult / state.spendMultiplier;
        state.spendMultiplier = newMult;
        state.spend *= factor;
        taxOwed = rmdAmount > grossBaseSpend
          ? rmdAmount * taxRate + Math.max(0, state.spend - rmdAmount) * effTaxRate
          : state.spend - Math.max(0, baseSpend * factor);
        gkEvent = 'Prosperity Guardrail: Gross portfolio withdrawal rate dropped below 80% of your starting rate. Spending temporarily raised by 10%.';
        state.gkFiredLastYear = true;
        state.gkAdjustmentYear = year;
      } else {
        state.gkFiredLastYear = false;
      }
    }

    const startCash = state.cash;
    const startStock = state.stock;
    const startBond = state.bond;

    const returns = annualReturns[year - 1];

    // Accumulate stochastic inflation for accurate nominal-dollar conversion.
    cumulativeInflationFactor *= (1 + returns.inflation);

    // nominalAssumptions is forwarded from runSimulation so the audit log uses the
    // same stock return assumption as the 100,000-run simulation (not the hardcoded default).
    void nominalAssumptions; // parameter is not used in simulateYear — it was used by generateAnnualReturns
    // Note: the returns array passed in already encodes the correct distribution drawn
    // by generateAnnualReturns(dynamicAssumptions, ...) in runSimulation, so the audit
    // rows reflect the user's expectedStockReturn automatically via the stored returns.

    // --- Early-withdrawal penalty (IRS Rule 72(t)) ---
    // Pre-59½: 10% federal penalty on the Traditional IRA/401(k) portion of any
    // distribution that exceeds the SEPP cap (or the entire Trad portion when SEPP
    // isn't used). The penalty must be paid out of the portfolio, so we add it to
    // state.spend so simulateYear withdraws enough to cover it.
    // SEPP cap is the LOCKED inception value (computed once outside the loop) until
    // 59½, then 0 — Fixed-Amortization rules forbid year-over-year recalculation.
    const seppCap = ageThisYear >= 59.5 ? 0 : seppCapLocked;
    let earlyPenalty = computeEarlyPenalty(state.spend, ageThisYear, inputs, seppCap);
    state.spend += earlyPenalty;

    const outcome = simulateYear(state, returns, inputs, strategy, { stock: targetStockWeight, bond: targetBondWeight, cash: targetCashWeight });

    // When the portfolio is nearly depleted, simulateYear caps actualWithdrawal below
    // state.spend. Scale taxOwed and earlyPenalty proportionally so the audit doesn't
    // show more tax/penalty than the fraction of the withdrawal that actually occurred.
    // (Without scaling penalty, "Spend = withdrawal − tax − penalty" can go negative
    // in the final depletion year.)
    if (state.spend > 0.01 && outcome.withdrawal < state.spend - 0.01) {
      const scale = outcome.withdrawal / state.spend;
      taxOwed *= scale;
      earlyPenalty *= scale;
    }

    // Nominal withdrawal uses the exact cumulative product of stochastic inflation
    // draws (not a fixed-rate approximation) for a precise 1099-R reference figure.
    const nominalWithdrawal = outcome.withdrawal * cumulativeInflationFactor;

    log.push({
      year: startYear + year,
      startCash,
      // In Year 1, add the setup friction back to startStock so the
      // logged start balance equals the user's original input portfolio. The matching
      // initialSetupCost is added to feesAmount below so the audit math
      // (Start + Growth − Fees − Draw = End) still balances exactly.
      startStock: year === 1 ? startStock + initialSetupCost : startStock,
      startBond,
      stockReturn: returns.stock,
      bondReturn: returns.bond,
      cashReturn: returns.cash,
      realizedInflation: returns.inflation,
      growthAmount: outcome.growth,
      feesAmount: outcome.fees + (year === 1 ? initialSetupCost : 0),
      action: outcome.actionLog, // strategy-only mechanical action
      gkEvent,                              // G-K event isolated for styled badge rendering
      withdrawal: outcome.withdrawal,
      taxPaid: taxOwed,
      endTotal: outcome.nextState.stock + outcome.nextState.bond + outcome.nextState.cash,
      rmdAmount,
      nominalWithdrawal,
      ssIncome: ssIncomeThisYear,
      spendMultiplier: state.spendMultiplier, // current accumulated G-K factor this year
      crashed: returns.crashed,        // jump-diffusion flag for audit annotation
      seppCap,                              // 0 once age ≥ 59½
      earlyPenalty,                         // 0 once age ≥ 59½ or no Trad balance
      healthcareSpend,                      // 0 when includeHealthcare is false
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

  const { initialCash, initialInvestments, spendingPhases, timeHorizon, inflationRate } = inputs;
  const totalStartPortfolio = initialCash + initialInvestments;

  let targetStockWeight = 0;
  let targetBondWeight = 0;
  let targetCashWeight = 0;
  if (strategy === 'CONSERVATIVE') { targetBondWeight = 0.40; targetStockWeight = 0.60; }
  else if (strategy === 'AGGRESSIVE') { targetBondWeight = 0.30; targetStockWeight = 0.70; }
  else if (strategy === 'CUSTOM') {
    targetStockWeight = inputs.customStockAllocation / 100;
    targetCashWeight = inputs.customCashAllocation / 100;
    targetBondWeight = Math.max(0, 1.0 - targetStockWeight - targetCashWeight);
  }

  // meanInflation passed to generateAnnualReturns as a decimal.
  // Stochastic inflation is drawn per-year inside that function, so there is no
  // longer a single REAL_ASSUMPTIONS constant — it varies with every draw.
  const meanInflation = inflationRate / 100;

  const dynamicAssumptions = {
    STOCK: { mean: inputs.expectedStockReturn / 100, stdDev: inputs.expectedStockVolatility / 100 },
    BOND: { mean: inputs.expectedBondReturn / 100, stdDev: NOMINAL_ASSUMPTIONS.BOND.stdDev },
    CASH: { mean: inputs.expectedCashReturn / 100, stdDev: NOMINAL_ASSUMPTIONS.CASH.stdDev },
  };

  const allRuns: SimulationRun[] = [];
  // Use Float64Array for column-based storage (Performance Optimization)
  const trajectoryColumns: Float64Array[] = Array(timeHorizon).fill(0).map(() => new Float64Array(NUM_SIMULATIONS));

  let failures = 0;
  // Comfortable Survival: count runs where the FINAL balance is below 25% of the
  // strategy-adjusted starting portfolio (post day-0 setup costs) in real terms.
  // This keeps cross-strategy comparisons fair when setup friction differs.
  let comfortableFailures = 0;
  let totalAnnualizedVol = 0;

  const initialSpend = getSpendingForYear(0, spendingPhases);
  const initializedForThreshold = initializeStartingState(inputs, strategy, targetStockWeight, targetBondWeight, targetCashWeight, initialSpend);
  const startAfterSetup = initializedForThreshold.state.stock + initializedForThreshold.state.bond + initializedForThreshold.state.cash;
  const comfortThreshold = startAfterSetup * 0.25;

  // SEPP / Rule 72(t) Fixed-Amortization cap: locked once at simulation start from
  // the post-setup Trad+Roth balance. IRS rules forbid year-over-year recalculation
  // for the Amortization method, so this single value is reused across all 100,000
  // runs (the inception balance is identical — only future returns differ).
  const initialRetirementBalanceMC = (initializedForThreshold.state.stock + initializedForThreshold.state.bond + initializedForThreshold.state.cash)
    * ((inputs.taxDeferredRatio + inputs.rothRatio) / 100);
  const seppCapLockedMC = computeSEPPCap(initialRetirementBalanceMC, inputs.currentAge, inputs.seppRate);

  for (let sim = 0; sim < NUM_SIMULATIONS; sim++) {
    const initialized = initializeStartingState(inputs, strategy, targetStockWeight, targetBondWeight, targetCashWeight, initialSpend);
    let state = initialized.state;

    const currentRunReturns: { stock: number; bond: number; cash: number; inflation: number; crashed: boolean }[] = [];
    // Store local trajectory for this run in a typed array
    const currentRunTrajectory = new Float64Array(timeHorizon);
    const runPortfolioReturns: number[] = [];

    // Phase-transition tracking: mirrors generateAuditLog.
    let prevRawPhaseSpend = initialSpend;

    let prevBalance = state.stock + state.bond + state.cash;
    // Track the prior year's TOTAL portfolio return for G-K direction checks.
    // Using stock-only return (previous approach) gives wrong results when bonds
    // move against stocks, e.g. stocks +5% / bonds -15% on 60/40 = -3% portfolio.
    let prevYearPortfolioReturn = 0;
    let prevSsIncomeActive = false;

    for (let year = 0; year < timeHorizon; year++) {
      // Update spend for the current phase before simulateYear consumes state.spend
      let baseSpend = getSpendingForYear(year, spendingPhases);
      // Detect spending phase transitions (mirrors generateAuditLog logic).
      const rawPhaseSpend = baseSpend;
      const phaseChanged = year > 0 && rawPhaseSpend !== prevRawPhaseSpend;
      prevRawPhaseSpend = rawPhaseSpend;

      // --- RMD & Tax Gross-Up (mirrors generateAuditLog logic exactly) ---
      // year is 0-based here; add 1 to align with the 1-based convention in
      // generateAuditLog so both functions compute the same IRS age for the
      // same retirement year (avoids a 1-year RMD trigger discrepancy).
      const ageThisYear = inputs.currentAge + year + 1;

      // Healthcare add-on (real $). Mirrors generateAuditLog: applied AFTER phase
      // detection so it doesn't trip false G-K resets, but BEFORE SS / tax gross-up.
      baseSpend += getHealthcareSpend(ageThisYear, inputs.includeHealthcare, year);

      // Supplemental Income offsets need for portfolio withdrawals.
      // Also detect first SS activation for G-K IWR baseline reset (mirrors generateAuditLog).
      const ssActive = ageThisYear >= inputs.socialSecurityAge;
      const ssIncomeJustActivated = !prevSsIncomeActive && ssActive;
      prevSsIncomeActive = ssActive;
      const isPhaseTransition = phaseChanged || ssIncomeJustActivated;

      // Reset the Guyton-Klinger penalty/bonus during Phase Transitions.
      if (isPhaseTransition) {
        state.spendMultiplier = 1.0;
        state.gkAdjustmentYear = null;
      }

      // After exactly 1 year of adjustment, force multiplier back to 1.0
      if (state.gkAdjustmentYear !== null && year - state.gkAdjustmentYear === 1) {
        state.spendMultiplier = 1.0;
      }

      // Blended effective tax rate: only the fraction held in tax-deferred accounts
      // is taxable on withdrawal. See generateAuditLog for the identical derivation.
      const taxRate = inputs.withdrawalTaxRate / 100;
      const effTaxRate = taxRate * (inputs.taxDeferredRatio / 100);

      if (ssActive) {
        // 85% rule: SS income is not 100% tax-free for high-income retirees.
        // Under IRS rules, up to 85% of Social Security benefits can be taxed.
        baseSpend -= inputs.socialSecurityIncome * 12 * (1 - taxRate * 0.85);
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
        taxOwed = rmdThisYear * taxRate;
      } else {
        state.spend = grossBaseSpend;
        taxOwed = grossBaseSpend - Math.max(0, baseSpend);
      }

      // --- Guyton-Klinger Guardrail Check ---
      // Mirrors generateAuditLog exactly: cooldown + floor/ceiling + phase-transition reset.
      const currentWR = totalPreWithdrawal > 0.01 ? state.spend / totalPreWithdrawal : 0;

      if (year === 0 || isPhaseTransition) {
        state.iwr = currentWR;
        state.gkFiredLastYear = false;
        state.gkAdjustmentYear = null;
      } else if (state.gkAdjustmentYear !== null && year - state.gkAdjustmentYear === 1) {
        // Adjustment year ended: re-baseline IWR and enforce 1-year cooldown
        state.iwr = currentWR;
        state.gkFiredLastYear = false;
      } else if (state.iwr > 0.0001) {
        if (!state.gkFiredLastYear && currentWR > state.iwr * 1.20 && prevYearPortfolioReturn < 0) {
          const newMult = state.spendMultiplier * 0.90;
          const factor = newMult / state.spendMultiplier;
          state.spendMultiplier = newMult;
          state.spend *= factor;
          // never cut spending below the IRS RMD floor.
          state.spend = Math.max(state.spend, rmdThisYear);
          // Tax formula: if spending is at the RMD floor (original RMD floor or clamped
          // back up after the 10% cut), treat the full distribution as taxable.
          taxOwed = state.spend <= rmdThisYear + 1
            ? state.spend * taxRate
            : state.spend - Math.max(0, baseSpend * factor);
          state.gkFiredLastYear = true;
          state.gkAdjustmentYear = year;
        } else if (!state.gkFiredLastYear && currentWR > 0 && currentWR < state.iwr * 0.80 && prevYearPortfolioReturn > 0) {
          // currentWR > 0 prevents a depleted portfolio from triggering
          // an endless loop of 10% raises (CWR = 0 always satisfies < 0.80 × IWR).
          const newMult = state.spendMultiplier * 1.10;
          const factor = newMult / state.spendMultiplier;
          state.spendMultiplier = newMult;
          state.spend *= factor;
          taxOwed = rmdThisYear > grossBaseSpend
            ? rmdThisYear * taxRate + Math.max(0, state.spend - rmdThisYear) * effTaxRate
            : state.spend - Math.max(0, baseSpend * factor);
          state.gkFiredLastYear = true;
          state.gkAdjustmentYear = year;
        } else {
          state.gkFiredLastYear = false;
        }
      }

      // --- Early-withdrawal penalty (Rule 72(t)) — mirrors generateAuditLog. ---
      // SEPP cap is the LOCKED inception value until 59½, then 0. Pre-59½ Traditional
      // draws above the cap incur a 10% federal penalty, paid out of the portfolio
      // (added to state.spend so simulateYear actually withdraws enough to cover it).
      const seppCapThisYear = ageThisYear >= 59.5 ? 0 : seppCapLockedMC;
      state.spend += computeEarlyPenalty(state.spend, ageThisYear, inputs, seppCapThisYear);

      // generateAnnualReturns now takes nominal assumptions + mean inflation and
      // produces real returns with per-year stochastic inflation baked in.
      // The cash floor is handled inside the function.
      const returns = generateAnnualReturns(dynamicAssumptions, meanInflation);
      currentRunReturns.push(returns);

      const outcome = simulateYear(state, returns, inputs, strategy, { stock: targetStockWeight, bond: targetBondWeight, cash: targetCashWeight });

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

    // Zero-Touch Rate: failure if portfolio touches $1 or below at ANY point across the
    // full horizon — even if Social Security income later restores it. Stricter than industry.
    const droppedToZero = currentRunTrajectory.some(val => val <= 1);
    if (droppedToZero) failures++;

    // Comfortable Survival Rate: failure if the FINAL real balance is below 25% of the
    // strategy-adjusted starting portfolio. Captures plans that technically survived
    // but ended dangerously low.
    const finalValSafe = Math.max(0, finalVal);
    const belowComfortThreshold = finalValSafe < comfortThreshold;
    if (belowComfortThreshold) comfortableFailures++;

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
    const pDown = Math.max(0.01, Math.min(0.99, inputs.percentileDownturn / 100));
    const pBelow = Math.max(0.01, Math.min(0.99, inputs.percentileBelowAverage / 100));
    const pAvg = Math.max(0.01, Math.min(0.99, inputs.percentileAverage / 100));
    downturnCurve.push(yearValues[Math.ceil(NUM_SIMULATIONS * pDown) - 1]);
    belowAverageCurve.push(yearValues[Math.ceil(NUM_SIMULATIONS * pBelow) - 1]);
    averageCurve.push(yearValues[Math.ceil(NUM_SIMULATIONS * pAvg) - 1]);
  }

  // Map $0 trajectories to null so Recharts renders a gap at depletion
  // (connectNulls={false}) instead of a misleading flatline at $0.
  // The YearResult type uses `number | null` precisely for this purpose.
  const toNullable = (v: number): number | null => v <= 0 ? null : v;

  const chartData: YearResult[] = averageCurve.map((val, idx) => ({
    year: currentYear + idx + 1,
    average: toNullable(val),
    belowAverage: toNullable(belowAverageCurve[idx]),
    downturn: toNullable(downturnCurve[idx]),
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
  let dispCash = targetCashWeight;
  if (strategy === 'BUCKET') {
    // Use the same grossed-up initial spend as the simulation initialization so
    // the displayed allocation exactly matches what the engine sets up on day one.
    const rawInitialSpend = getSpendingForYear(0, spendingPhases);
    const grossedUpInitialSpend = computeFirstYearGrossedUpSpend(rawInitialSpend, totalStartPortfolio, inputs);
    const startCash = Math.min(totalStartPortfolio * 0.50, 2 * Math.max(grossedUpInitialSpend, 0));
    if (totalStartPortfolio > 0) {
      dispCash = startCash / totalStartPortfolio;
      dispStock = 1.0 - dispCash;
      dispBond = 0;
    }
  }

  return {
    data: chartData,
    auditLogAverage,
    auditLogBelowAverage,
    auditLogDownturn,
    // Zero-Touch / Plan Survival Rate: never touched $1 or below at any point in the horizon.
    successRate: ((NUM_SIMULATIONS - failures) / NUM_SIMULATIONS) * 100,
    // Comfortable Survival Rate: ends with ≥ 25% of post-setup starting real portfolio value.
    // Meaningfully different from successRate — separates "survived but depleted" from
    // "plan worked well with meaningful reserves remaining."
    comfortableSurvivalRate: ((NUM_SIMULATIONS - comfortableFailures) / NUM_SIMULATIONS) * 100,
    comfortFloorValue: comfortThreshold,
    finalMedianValue: finalMedian,
    volatility: avgVol,
    allocation: { stock: dispStock, bond: dispBond, cash: dispCash },
    timestamp: Date.now()
  };
};
