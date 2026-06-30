import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
  verifyAndCompleteSwap,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction } from "../state.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW } from "../config.js";
import { getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import { execSync, spawn } from "child_process";
import { REPO_ROOT, repoPath } from "../repo-root.js";
import { normalizeTimeframe, scaleScreeningToTimeframe } from "../screening-scales.js";

const USER_CONFIG_PATH = repoPath("user-config.json");
const GMGN_CONFIG_PATH = repoPath("gmgn-config.json");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap, notifySwapError } from "../telegram.js";

const SENSITIVE_CONFIG_KEYS = new Set([
  "gmgnApiKey",
  "publicApiKey",
]);

function redactConfigValue(key, value) {
  if (!SENSITIVE_CONFIG_KEYS.has(key)) return value;
  return typeof value === "string" && value ? "***redacted***" : value;
}

function redactAppliedConfig(applied) {
  return Object.fromEntries(
    Object.entries(applied || {}).map(([key, value]) => [key, redactConfigValue(key, value)]),
  );
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function validateDeployPoolThresholds(args) {
  let detail;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
  const minFeeActiveTvlRatio = numberOrNull(config.screening.minFeeActiveTvlRatio);
  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
  ) {
    return {
      pass: false,
      reason: `Pool fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}%.`,
    };
  }

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail = detail;
  if ((config.screening.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  const volatility = poolDetailVolatility(volatilityDetail);
  if (volatility == null || volatility <= 0) {
    return {
      pass: false,
      reason: `Pool ${volatilityTimeframe} volatility ${volatility ?? "unknown"} is unusable. Refusing deploy.`,
    };
  }

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  const baseMint = detail?.token_x?.address || detail?.base_token_address || null;
  const entryMarketData = {
    entry_mcap: numberOrNull(detail?.token_x?.market_cap ?? detail?.base_token_market_cap),
    entry_tvl: tvl,
    entry_volume: numberOrNull(detail?.volume),
    entry_holders: numberOrNull(detail?.base_token_holders ?? detail?.token_x?.holders),
  };

  return { pass: true, entryMarketData };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: REPO_ROOT,
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      screeningSource: ["screening", "source"],
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      quoteCurrency:       ["management", "quoteCurrency"],
      deployAmountUsdc:    ["management", "deployAmountUsdc"],
      maxDeployAmountUsdc: ["management", "maxDeployAmountUsdc"],
      positionSizePctUsdc: ["management", "positionSizePctUsdc"],
      gasReserveUsdc:      ["management", "gasReserveUsdc"],
      minUsdcToOpen:       ["management", "minUsdcToOpen"],

      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy:     ["strategy", "strategy"],
      binsBelow:    ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      publicApiKey: ["api", "publicApiKey"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // pnl fetcher / poller
      pnlSource: ["pnl", "source"],
      pnlRpcUrl: ["pnl", "rpcUrl"],
      pnlPollIntervalSec: ["pnl", "pollIntervalSec"],
      pnlDepositCacheTtlSec: ["pnl", "depositCacheTtlSec"],
      // GMGN screening
      gmgnFeeSource: ["gmgn", "feeSource"],
      gmgnApiKey: ["gmgn", "apiKey"],
      gmgnBaseUrl: ["gmgn", "baseUrl"],
      gmgnInterval: ["gmgn", "interval"],
      gmgnOrderBy: ["gmgn", "orderBy"],
      gmgnDirection: ["gmgn", "direction"],
      gmgnLimit: ["gmgn", "limit"],
      gmgnEnrichLimit: ["gmgn", "enrichLimit"],
      gmgnRequestDelayMs: ["gmgn", "requestDelayMs"],
      gmgnMaxRetries: ["gmgn", "maxRetries"],
      gmgnHoldersLimit: ["gmgn", "holdersLimit"],
      gmgnKlineResolution: ["gmgn", "klineResolution"],
      gmgnKlineLookbackMinutes: ["gmgn", "klineLookbackMinutes"],
      gmgnFilters: ["gmgn", "filters"],
      gmgnPlatforms: ["gmgn", "platforms"],
      gmgnMinMcap: ["gmgn", "minMcap"],
      gmgnMaxMcap: ["gmgn", "maxMcap"],
      gmgnMinVolume: ["gmgn", "minVolume"],
      gmgnMinHolders: ["gmgn", "minHolders"],
      gmgnMinTokenAgeHours: ["gmgn", "minTokenAgeHours"],
      gmgnMaxTokenAgeHours: ["gmgn", "maxTokenAgeHours"],
      gmgnAthFilterPct: ["gmgn", "athFilterPct"],
      gmgnMaxTop10HolderRate: ["gmgn", "maxTop10HolderRate"],
      gmgnMaxBundlerRate: ["gmgn", "maxBundlerRate"],
      gmgnMaxRatTraderRate: ["gmgn", "maxRatTraderRate"],
      gmgnMaxFreshWalletRate: ["gmgn", "maxFreshWalletRate"],
      gmgnMaxDevTeamHoldRate: ["gmgn", "maxDevTeamHoldRate"],
      gmgnMaxBotDegenRate: ["gmgn", "maxBotDegenRate"],
      gmgnMaxSniperCount: ["gmgn", "maxSniperCount"],
      gmgnMaxSniperHoldRate: ["gmgn", "maxSniperHoldRate"],
      gmgnPreferredKolNames: ["gmgn", "preferredKolNames"],
      gmgnPreferredKolMinHoldPct: ["gmgn", "preferredKolMinHoldPct"],
      gmgnDumpKolNames: ["gmgn", "dumpKolNames"],
      gmgnDumpKolMinHoldPct: ["gmgn", "dumpKolMinHoldPct"],
      gmgnRequireKol: ["gmgn", "requireKol"],
      gmgnMinKolCount: ["gmgn", "minKolCount"],
      gmgnMinSmartDegenCount: ["gmgn", "minSmartDegenCount"],
      gmgnMinTotalFeeSol: ["gmgn", "minTotalFeeSol"],
      gmgnIndicatorFilter: ["gmgn", "indicatorFilter"],
      gmgnIndicatorInterval: ["gmgn", "indicatorInterval"],
      gmgnRequireBullishSt: ["gmgn", "indicatorRules", "requireBullishSupertrend"],
      gmgnRejectAtBottom: ["gmgn", "indicatorRules", "rejectAlreadyAtBottom"],
      gmgnRequireAboveSt: ["gmgn", "indicatorRules", "requireAboveSupertrend"],
      gmgnMinRsi: ["gmgn", "indicatorRules", "minRsi"],
      gmgnMaxRsi: ["gmgn", "indicatorRules", "maxRsi"],
      gmgnRequireBbPosition: ["gmgn", "indicatorRules", "requireBbPosition"],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );
    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      let normalizedVal = val;
      if (STRATEGY_BIN_KEYS.has(match[0])) {
        const numericVal = Number(val);
        if (!Number.isFinite(numericVal)) {
          unknown.push(key);
          continue;
        }
        normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
      }
      applied[match[0]] = normalizedVal;
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    // Auto-scale fee/volume when timeframe changes (unless user set them explicitly in same call).
    if (applied.timeframe != null && applied.minFeeActiveTvlRatio == null && applied.minVolume == null) {
      const tf = normalizeTimeframe(applied.timeframe);
      applied.timeframe = tf;
      const scaled = scaleScreeningToTimeframe(tf);
      applied.minFeeActiveTvlRatio = scaled.minFeeActiveTvlRatio;
      applied.minVolume = scaled.minVolume;
      applied._timeframeScaled = true;
      log("config", `timeframe ${tf} → auto-scaled minFeeActiveTvlRatio=${scaled.minFeeActiveTvlRatio}, minVolume=${scaled.minVolume}`);
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const [section, field, third] = CONFIG_MAP[key];
      const isNestedField = typeof third === "string";
      if (isNestedField) {
        if (!config[section][field] || typeof config[section][field] !== "object") config[section][field] = {};
        const before = config[section][field][third];
        config[section][field][third] = val;
        log("config", `update_config: config.${section}.${field}.${third} ${redactConfigValue(key, before)} → ${redactConfigValue(key, val)}`);
      } else {
        const before = config[section][field];
        config[section][field] = val;
        log("config", `update_config: config.${section}.${field} ${redactConfigValue(key, before)} → ${redactConfigValue(key, val)} (verify: ${redactConfigValue(key, config[section][field])})`);
      }
    }
    if (
      applied.binsBelow != null ||
      applied.minBinsBelow != null ||
      applied.maxBinsBelow != null ||
      applied.defaultBinsBelow != null
    ) {
      config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
      config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
      config.strategy.defaultBinsBelow = Math.max(
        config.strategy.minBinsBelow,
        Math.min(
          config.strategy.maxBinsBelow,
          Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow)),
        ),
      );
    }

    // Persist GMGN tuning to gmgn-config.json, and everything else to user-config.json.
    let gmgnConfig = {};
    if (fs.existsSync(GMGN_CONFIG_PATH)) {
      try { gmgnConfig = JSON.parse(fs.readFileSync(GMGN_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    let wroteUserConfig = false;
    let wroteGmgnConfig = false;
    for (const [key, val] of Object.entries(applied)) {
      if (key.startsWith("_")) continue;
      const [section, field, third] = CONFIG_MAP[key] || [];
      const persistPath = Array.isArray(third) ? third : null;
      const nestedField = typeof third === "string" ? third : null;
      if (section === "gmgn") {
        if (nestedField) {
          if (!gmgnConfig[field] || typeof gmgnConfig[field] !== "object") gmgnConfig[field] = {};
          gmgnConfig[field][nestedField] = val;
        } else {
          gmgnConfig[field] = val;
        }
        wroteGmgnConfig = true;
        continue;
      }
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = userConfig;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        userConfig[key] = val;
      }
      wroteUserConfig = true;
    }
    const tunedAt = new Date().toISOString();
    if (wroteUserConfig) {
      userConfig._lastAgentTune = tunedAt;
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));
    }
    if (wroteGmgnConfig) {
      gmgnConfig._lastAgentTune = tunedAt;
      fs.writeFileSync(GMGN_CONFIG_PATH, JSON.stringify(gmgnConfig, null, 2));
    }

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null || applied.pnlPollIntervalSec != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Save as a lesson — but skip ephemeral per-deploy interval changes
    // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
    //  the rule is already in the system prompt, storing it 75+ times is pure noise)
    const lessonsKeys = Object.keys(applied).filter(
      k => !k.startsWith("_") && k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${redactConfigValue(k, applied[k])}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(redactAppliedConfig(applied))} — ${reason}`);
    return { success: true, applied: redactAppliedConfig(applied), unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
// Deploy cooldown: prevent deploying to same pool within N ms (race condition guard)
const _recentlyDeployedPools = new Map();
const DEPLOY_COOLDOWN_MS = 5 * 60 * 1000;

const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Register deploy cooldown BEFORE swap+deploy (not after) ──────────────
  // Prevents race condition: concurrent deploy_position calls bypass safety checks
  // because position #1 isn't on-chain yet and cooldown wasn't set.
  if (name === "deploy_position" && args.pool_address) {
    _recentlyDeployedPools.set(args.pool_address, Date.now());
  }

  // ─── USDC mode: swap deploy budget right before deploy (with rollback) ──
  const isUsdcDeploy = name === "deploy_position" && config.management.quoteCurrency === "USDC" && process.env.DRY_RUN !== "true";
  const RENT_BUFFER = config.management.rentBufferSol ?? 0.06;
  let preDeploySol = 0;
  if (isUsdcDeploy) {
    const balances = await getWalletBalances();
    preDeploySol = balances.sol;
    const usdcDeployBudget = config.management.deployAmountUsdc || 0;
    log("executor", `Swapping deploy budget ${usdcDeployBudget} USDC → SOL for position (rollback-ready)`);
    const swapResult = await swapToken({ input_mint: config.tokens.USDC, output_mint: "SOL", amount: usdcDeployBudget });
    if (!swapResult?.success) {
      return { success: false, error: `USDC→SOL swap failed for deploy capital: ${swapResult?.error || "unknown"}` };
    }
    const solFromSwap = parseFloat(swapResult.amount_out);
    if (!Number.isFinite(solFromSwap) || solFromSwap <= 0) {
      return { success: false, error: `USDC→SOL swap returned invalid amount: ${swapResult.amount_out}` };
    }
    // Deduct rent/tx buffer from deploy amount — reserve SOL stays untouched
    const deployAmount = solFromSwap - RENT_BUFFER;
    if (deployAmount <= 0) {
      return { success: false, error: `Swap yield ${solFromSwap} SOL too small after reserving ${RENT_BUFFER} SOL for rent/tx fees.` };
    }
    args.amount_y = deployAmount;
    args.amount_sol = deployAmount;
  }

  // ─── Execute ──────────────────────────────
  try {
    // Snapshot SOL before close for delta calculation (only swap position proceeds)
    let preCloseSol = 0;
    if (name === "close_position") {
      try {
        const preBal = await getWalletBalances({});
        preCloseSol = preBal.sol;
      } catch (_) { /* best effort */ }
    }

    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    // Rollback USDC→SOL swap if deploy returned failure (no exception thrown)
    if (isUsdcDeploy && !success) {
      try {
        const postFailBalances = await getWalletBalances();
        const solDelta = postFailBalances.sol - preDeploySol;
        if (solDelta > 0.005) {
          log("executor", `Rolling back: swapping ${solDelta.toFixed(4)} SOL → USDC after deploy failure`);
          await swapToken({ input_mint: "SOL", output_mint: config.tokens.USDC, amount: solDelta });
        }
      } catch (rollbackErr) {
        log("executor_warn", `USDC→SOL rollback failed: ${rollbackErr.message}`);
      }
    }

    // Auto-swap after close runs even if verification failed (txs went through on-chain)
    if (name === "close_position") {
      await handleCloseAutoSwap(name, args, result, preCloseSol);
    }

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
        if (args.pool_address) {
          _recentlyDeployedPools.set(args.pool_address, Date.now());
        }
      } else if (name === "close_position") {
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        const isUsdcMode = config.management.quoteCurrency === "USDC";
        const outputMint = isUsdcMode ? config.tokens.USDC : "SOL";
        const outputLabel = isUsdcMode ? "USDC" : "SOL";
        try {
          const balances = await getWalletBalances({});
          const token = balances.tokens?.find(t => t.mint === result.base_mint);
          if (token && token.usd >= 0.10) {
            const symbol = token.symbol || result.base_mint.slice(0, 8);
            log("executor", `Auto-swapping claimed ${symbol} ($${token.usd.toFixed(2)}) back to ${outputLabel}`);

            const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: outputMint, amount: token.balance });

            if (swapResult?.success) {
              log("executor", `Jupiter claim auto-swap succeeded: ${swapResult.tx}`);
            } else {
              log("executor_warn", `Jupiter claim auto-swap returned: ${swapResult?.error || "unknown"} — trying fallback`);
              const fallback = await verifyAndCompleteSwap({
                baseMint: result.base_mint,
                poolAddress: result.pool || result.pool_address,
                outputMint,
              });
              if (fallback.swapped) {
                log("executor", `Fallback claim auto-swap succeeded via ${fallback.method}: ${fallback.tx}`);
              } else {
                log("executor_error", `Claim auto-swap FAILED for ${symbol}: $${fallback.remaining_usd?.toFixed(2)} stuck in wallet`);
                notifySwapError({ pair: result.pool_name || symbol, tokenMint: result.base_mint, remainingUsd: fallback.remaining_usd, reason: "Claim: Jupiter → fallback gagal", poolAddress: result.pool || result.pool_address }).catch(() => {});
              }
            }
          }
        } catch (e) {
          log("executor_error", `Auto-swap after claim crashed: ${e.message}`);
          try {
            const fallback = await verifyAndCompleteSwap({
              baseMint: result.base_mint,
              poolAddress: result.pool || result.pool_address,
              outputMint,
            });
            if (!fallback.swapped) {
              notifySwapError({ pair: result.pool_name || result.base_mint?.slice(0, 8), tokenMint: result.base_mint, remainingUsd: fallback.remaining_usd, reason: "Claim crash recovery: semua gagal", poolAddress: result.pool || result.pool_address }).catch(() => {});
            }
          } catch (_) {}
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    // Rollback USDC→SOL swap if deploy failed
    if (isUsdcDeploy) {
      try {
        const postErrorBalances = await getWalletBalances();
        const solDelta = postErrorBalances.sol - preDeploySol;
        if (solDelta > 0.005) {
          log("executor", `Rolling back: swapping ${solDelta.toFixed(4)} SOL → USDC after deploy failure`);
          await swapToken({ input_mint: "SOL", output_mint: config.tokens.USDC, amount: solDelta });
        }
      } catch (rollbackErr) {
        log("executor_warn", `USDC→SOL rollback failed: ${rollbackErr.message}`);
      }
    }

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;
      if (poolThresholds.entryMarketData) Object.assign(args, poolThresholds.entryMarketData);

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove !== 0)
      ) {
        return {
          pass: false,
          reason: "Single-side SOL deploy must use bins_above=0.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Deploy cooldown: prevent deploying to same pool within DEPLOY_COOLDOWN_MS
      const lastDeploy = _recentlyDeployedPools.get(args.pool_address);
      if (lastDeploy && Date.now() - lastDeploy < DEPLOY_COOLDOWN_MS) {
        return {
          pass: false,
          reason: `Pool ${args.pool_address} was deployed to ${Math.round((Date.now() - lastDeploy) / 1000)}s ago — cooldown ${DEPLOY_COOLDOWN_MS / 1000}s.`,
        };
      }

      // Block same base token across different pools
      if (args.base_mint) {
        const alreadyHasMint = positions.positions.some(
          (p) => p.base_mint === args.base_mint
        );
        if (alreadyHasMint) {
          return {
            pass: false,
            reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
          };
        }
      }

      // Check amount limits
      const amountY = args.amount_y ?? args.amount_sol ?? 0;
      if (amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const isUsdcMode = config.management.quoteCurrency === "USDC";

      if (isUsdcMode) {
        const minDeployUsdc = Math.max(0.01, config.management.deployAmountUsdc);
        if (amountY < 0.01) {
          return {
            pass: false,
            reason: `Amount ${amountY} SOL is below the minimum deploy amount (0.01 SOL).`,
          };
        }
      } else {
        const minDeploy = Math.max(0.1, config.management.deployAmountSol);
        if (amountY < minDeploy) {
          return {
            pass: false,
            reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
          };
        }
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();

        if (isUsdcMode) {
          const usdcDeployBudget = config.management.deployAmountUsdc || 0;
          if (balance.usdc < usdcDeployBudget) {
            return {
              pass: false,
              reason: `Insufficient USDC: have ${balance.usdc} USDC, need ${usdcDeployBudget} USDC for deploy capital.`,
            };
          }
          // Minimal SOL check — just enough for tx fees to execute the swap
          if (balance.sol < 0.005) {
            return {
              pass: false,
              reason: `Insufficient SOL for transaction fees (${balance.sol.toFixed(4)} SOL). Need at least 0.005 SOL.`,
            };
          }
        } else {
          const minRequired = amountY + 0.005;
          if (balance.sol < minRequired) {
            return {
              pass: false,
              reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + 0.005 tx fees).`,
            };
          }
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Handle auto-swap after close_position — converts back to quote currency.
 * Runs even when close_position returns success:false (txs went through on-chain
 * but verification failed due to indexer delay).
 * Only swaps the delta (position proceeds), preserving pre-existing SOL (gas reserve).
 */
async function handleCloseAutoSwap(name, args, result, preCloseSol) {
  if (args.skip_swap) return;

  const isUsdcMode = config.management.quoteCurrency === "USDC";
  const outputMint = isUsdcMode ? config.tokens.USDC : "SOL";
  const outputLabel = isUsdcMode ? "USDC" : "SOL";

  // ── 1. Base token → USDC/SOL ──────────────────────────────────
  if (result.base_mint) {
    try {
      const balances = await getWalletBalances({});
      const token = balances.tokens?.find(t => t.mint === result.base_mint);
      if (token && token.usd >= 0.10) {
        const symbol = token.symbol || result.base_mint.slice(0, 8);
        log("executor", `Auto-swapping ${symbol} ($${token.usd.toFixed(2)}) back to ${outputLabel}`);
        const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: outputMint, amount: token.balance });

        if (swapResult?.success) {
          result.auto_swapped = true;
          result.auto_swap_note = `Base token auto-swapped to ${outputLabel} (${symbol} → ${outputLabel}).`;
          if (swapResult.amount_out) result.swap_received = swapResult.amount_out;
          log("executor", `Jupiter auto-swap succeeded: ${swapResult.tx}`);
        } else {
          log("executor_warn", `Jupiter auto-swap returned: ${swapResult?.error || "unknown error"} — trying fallback`);
          const fallback = await verifyAndCompleteSwap({
            baseMint: result.base_mint,
            poolAddress: result.pool || result.pool_address,
            outputMint,
          });
          if (fallback.swapped) {
            result.auto_swapped = true;
            result.auto_swap_method = fallback.method;
            result.auto_swap_note = `Base token auto-swapped via ${fallback.method} (${symbol} → ${outputLabel}).`;
            log("executor", `Fallback auto-swap succeeded via ${fallback.method}: ${fallback.tx}`);
          } else {
            result.auto_swapped = false;
            result.auto_swap_failed = true;
            result.auto_swap_note = `⚠️ Auto-swap FAILED — ${symbol} ($${fallback.remaining_usd?.toFixed(2)}) masih di wallet.`;
            log("executor_error", `Auto-swap FAILED for ${symbol}: ${fallback.remaining_usd?.toFixed(2)} stuck`);
            notifySwapError({ pair: result.pool_name || symbol, tokenMint: result.base_mint, remainingUsd: fallback.remaining_usd, reason: "Jupiter → fallback gagal", poolAddress: result.pool || result.pool_address }).catch(() => {});
          }
        }
      }
    } catch (e) {
      log("executor_error", `Base auto-swap crashed: ${e.message}`);
    }
  }

  // ── 2. SOL delta → USDC (USDC mode only) ──────────────────────
  if (isUsdcMode && preCloseSol > 0) {
    try {
      const balances = await getWalletBalances({});
      const solDelta = Math.max(0, balances.sol - preCloseSol);
      if (solDelta > 0.01) {
        log("executor", `USDC mode: swapping SOL delta ${solDelta.toFixed(3)} (post-close: ${balances.sol.toFixed(3)}, pre-close: ${preCloseSol.toFixed(3)})`);
        const solSwapResult = await swapToken({
          input_mint: config.tokens.SOL,
          output_mint: config.tokens.USDC,
          amount: solDelta,
        });
        if (solSwapResult?.success) {
          log("executor", `SOL→USDC delta swap succeeded: ${solSwapResult.tx}`);
          result.sol_swapped_to_usdc = true;
          result.sol_swapped_amount = solDelta;
        } else {
          log("executor_warn", `SOL→USDC delta swap failed: ${solSwapResult?.error}`);
        }
      }
    } catch (e) {
      log("executor_error", `SOL→USDC delta swap crashed: ${e.message}`);
    }
  }

  // ── 3. Notification ────────────────────────────────────────────
  notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0, reason: args.reason }).catch(() => {});
  if (args.reason && args.reason.toLowerCase().includes("yield")) {
    const poolAddr = result.pool || args.pool_address;
    if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
