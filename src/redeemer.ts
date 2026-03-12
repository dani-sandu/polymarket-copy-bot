import axios from 'axios';
import { ethers } from 'ethers';
import { config } from './config.js';
import { logger } from './logger.js';

const DATA_API_POSITIONS = 'https://data-api.polymarket.com/positions';
const GAMMA_API = 'https://gamma-api.polymarket.com';

const CTF_ABI = [
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];

const NEG_RISK_ADAPTER_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts)',
];

interface ApiPosition {
  conditionId: string;
  asset: string;       // token_id
  size: string;
  redeemable: boolean;
  title?: string;
  outcome?: string;
  outcomeIndex?: string;
}

interface GammaMarket {
  resolved?: boolean;
  neg_risk?: boolean;
  tokens?: Array<{ outcome: string; winner?: boolean }>;
}

interface SweepResult {
  scanned: number;
  redeemed: number;
  skipped: number;
  errors: number;
}

export class Redeemer {
  private provider: ethers.providers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private ctf: ethers.Contract;
  private negRiskAdapter: ethers.Contract;
  private fundingAddress: string;
  private dryRun: boolean;
  private intervalSecs: number;
  private running = false;

  private readonly MIN_PRIORITY_FEE_GWEI = parseFloat(process.env.MIN_PRIORITY_FEE_GWEI || '30');
  private readonly MIN_MAX_FEE_GWEI = parseFloat(process.env.MIN_MAX_FEE_GWEI || '60');
  private readonly MIN_BALANCE = 0.001; // skip positions smaller than this

  constructor() {
    this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.fundingAddress = config.proxyWallet || this.wallet.address;
    this.dryRun = config.redeemer.dryRun;
    this.intervalSecs = config.redeemer.intervalSecs;

    this.ctf = new ethers.Contract(config.contracts.ctf, CTF_ABI, this.wallet);
    this.negRiskAdapter = new ethers.Contract(config.contracts.negRiskAdapter, NEG_RISK_ADAPTER_ABI, this.wallet);
  }

  /** Start the background sweep loop. */
  async start(): Promise<void> {
    this.running = true;
    logger.info(`[REDEEMER] Started (interval=${this.intervalSecs}s, dryRun=${this.dryRun})`);
    logger.info(`[REDEEMER] Wallet: ${this.fundingAddress}`);

    // Initial delay before first sweep
    await this.sleep(60_000);

    while (this.running) {
      try {
        const result = await this.runSweep();
        if (result.redeemed > 0) {
          logger.info(`[REDEEMER] Sweep complete: redeemed ${result.redeemed}/${result.scanned} positions`);
        }
      } catch (err: any) {
        logger.error(`[REDEEMER] Sweep error: ${err.message}`);
      }
      await this.sleep(this.intervalSecs * 1000);
    }
  }

  stop(): void {
    this.running = false;
    logger.info('[REDEEMER] Stopped');
  }

  /** Single sweep: fetch positions, find resolved, redeem. */
  async runSweep(): Promise<SweepResult> {
    const result: SweepResult = { scanned: 0, redeemed: 0, skipped: 0, errors: 0 };

    // Phase 1: Fetch positions
    const positions = await this.fetchPositions();
    if (positions.length === 0) {
      return result;
    }

    // Group by conditionId (a market can have multiple outcome tokens)
    const byCondition = new Map<string, ApiPosition[]>();
    for (const pos of positions) {
      if (!pos.conditionId) continue;
      const existing = byCondition.get(pos.conditionId) || [];
      existing.push(pos);
      byCondition.set(pos.conditionId, existing);
    }

    result.scanned = byCondition.size;

    // Phase 2: Identify redeemable conditions
    for (const [conditionId, conditionPositions] of byCondition) {
      try {
        const title = conditionPositions[0]?.title || conditionId.slice(0, 16);

        // Quick check: API redeemable flag
        const anyRedeemable = conditionPositions.some(p => p.redeemable);
        if (!anyRedeemable) {
          // Fallback: check Gamma API for resolution status
          const resolution = await this.fetchMarketResolution(conditionId);
          if (!resolution || !resolution.resolved) {
            result.skipped++;
            continue;
          }
        }

        // Verify on-chain balance for at least one token
        let hasBalance = false;
        for (const pos of conditionPositions) {
          const balance = await this.ctf.balanceOf(this.fundingAddress, pos.asset);
          const balNum = parseFloat(ethers.utils.formatUnits(balance, 6));
          if (balNum >= this.MIN_BALANCE) {
            hasBalance = true;
            break;
          }
        }

        if (!hasBalance) {
          result.skipped++;
          continue;
        }

        // Determine if neg-risk
        let isNegRisk = false;
        const resolution = await this.fetchMarketResolution(conditionId);
        if (resolution) {
          isNegRisk = resolution.negRisk;
        }

        // Phase 3: Redeem
        logger.info(`[REDEEMER] Redeeming: "${title}" (${conditionId.slice(0, 12)}...) negRisk=${isNegRisk}`);

        if (this.dryRun) {
          logger.info(`[REDEEMER] [DRY RUN] Would redeem conditionId=${conditionId}`);
          result.redeemed++;
          continue;
        }

        const success = await this.sendRedeemTx(conditionId, isNegRisk);
        if (success) {
          result.redeemed++;
          logger.info(`[REDEEMER] ✅ Redeemed: "${title}"`);
        } else {
          result.errors++;
        }
      } catch (err: any) {
        result.errors++;
        logger.error(`[REDEEMER] Error processing ${conditionId.slice(0, 12)}: ${err.message}`);
      }
    }

    return result;
  }

  private async fetchPositions(): Promise<ApiPosition[]> {
    try {
      const res = await axios.get(DATA_API_POSITIONS, {
        params: {
          user: this.fundingAddress.toLowerCase(),
          limit: 200,
          sizeThreshold: 0,
        },
        headers: { Accept: 'application/json' },
      });
      const data: any[] = Array.isArray(res.data) ? res.data : [];
      return data
        .filter(p => parseFloat(p.size || '0') > this.MIN_BALANCE)
        .map(p => ({
          conditionId: p.conditionId || p.condition_id || '',
          asset: p.asset || p.asset_id || p.token_id || '',
          size: p.size || '0',
          redeemable: p.redeemable === true,
          title: p.title || '',
          outcome: p.outcome || '',
          outcomeIndex: p.outcomeIndex || p.outcome_index || '',
        }));
    } catch (err: any) {
      logger.error(`[REDEEMER] Failed to fetch positions: ${err.message}`);
      return [];
    }
  }

  private async fetchMarketResolution(conditionId: string): Promise<{ resolved: boolean; negRisk: boolean; winner?: string } | null> {
    try {
      const res = await axios.get(`${GAMMA_API}/markets`, {
        params: { conditionIds: conditionId },
        headers: { Accept: 'application/json' },
      });
      const markets: GammaMarket[] = Array.isArray(res.data) ? res.data : [];
      const market = markets[0];
      if (!market) return null;

      const resolved = market.resolved === true;
      const negRisk = market.neg_risk === true;
      const winnerToken = market.tokens?.find(t => t.winner === true);

      return { resolved, negRisk, ...(winnerToken?.outcome ? { winner: winnerToken.outcome } : {}) };
    } catch {
      return null;
    }
  }

  private async sendRedeemTx(conditionId: string, isNegRisk: boolean): Promise<boolean> {
    // Ensure NegRiskAdapter approval if needed
    if (isNegRisk) {
      await this.ensureNegRiskApproval();
    }

    const gasOverrides = await this.getGasOverrides();
    const conditionIdBytes = ethers.utils.hexZeroPad(
      conditionId.startsWith('0x') ? conditionId : `0x${conditionId}`,
      32
    );
    const indexSets = [1, 2]; // Both outcome slots

    // Try primary method first, fallback to the other
    if (isNegRisk) {
      // NegRisk: try adapter first, fallback to CTF direct
      try {
        await (this.negRiskAdapter.callStatic as any).redeemPositions(conditionIdBytes, indexSets);
        const tx = await this.negRiskAdapter.redeemPositions(conditionIdBytes, indexSets, gasOverrides);
        logger.info(`[REDEEMER] NegRisk redeem tx: ${tx.hash}`);
        const receipt = await tx.wait();
        return receipt.status === 1;
      } catch (negErr: any) {
        logger.warn(`[REDEEMER] NegRisk redeem failed, trying CTF direct: ${negErr.message}`);
        return this.redeemViaCTF(conditionIdBytes, indexSets, gasOverrides);
      }
    } else {
      // Standard: try CTF direct first, fallback to NegRisk adapter
      try {
        return await this.redeemViaCTF(conditionIdBytes, indexSets, gasOverrides);
      } catch (ctfErr: any) {
        logger.warn(`[REDEEMER] CTF redeem failed, trying NegRisk adapter: ${ctfErr.message}`);
        try {
          await (this.negRiskAdapter.callStatic as any).redeemPositions(conditionIdBytes, indexSets);
          const tx = await this.negRiskAdapter.redeemPositions(conditionIdBytes, indexSets, gasOverrides);
          logger.info(`[REDEEMER] NegRisk fallback redeem tx: ${tx.hash}`);
          const receipt = await tx.wait();
          return receipt.status === 1;
        } catch (negErr: any) {
          logger.error(`[REDEEMER] Both redeem methods failed for ${conditionIdBytes.slice(0, 12)}`);
          return false;
        }
      }
    }
  }

  private async redeemViaCTF(
    conditionIdBytes: string,
    indexSets: number[],
    gasOverrides: ethers.providers.TransactionRequest
  ): Promise<boolean> {
    const parentCollectionId = ethers.constants.HashZero;

    await (this.ctf.callStatic as any).redeemPositions(
      config.contracts.usdc,
      parentCollectionId,
      conditionIdBytes,
      indexSets
    );
    const tx = await this.ctf.redeemPositions(
      config.contracts.usdc,
      parentCollectionId,
      conditionIdBytes,
      indexSets,
      gasOverrides
    );
    logger.info(`[REDEEMER] CTF redeem tx: ${tx.hash}`);
    const receipt = await tx.wait();
    return receipt.status === 1;
  }

  private async ensureNegRiskApproval(): Promise<void> {
    const approved = await this.ctf.isApprovedForAll(this.fundingAddress, config.contracts.negRiskAdapter);
    if (approved) return;

    logger.info('[REDEEMER] Setting CTF approval for NegRiskAdapter...');
    const gasOverrides = await this.getGasOverrides();
    const tx = await this.ctf.setApprovalForAll(config.contracts.negRiskAdapter, true, gasOverrides);
    logger.info(`[REDEEMER] Approval tx: ${tx.hash}`);
    await tx.wait();
    logger.info('[REDEEMER] ✅ NegRiskAdapter approved');
  }

  private async getGasOverrides(): Promise<ethers.providers.TransactionRequest> {
    const feeData = await this.provider.getFeeData();
    const minPriority = ethers.utils.parseUnits(this.MIN_PRIORITY_FEE_GWEI.toString(), 'gwei');
    const minMaxFee = ethers.utils.parseUnits(this.MIN_MAX_FEE_GWEI.toString(), 'gwei');

    let maxPriority = feeData.maxPriorityFeePerGas || feeData.gasPrice || minPriority;
    let maxFee = feeData.maxFeePerGas || feeData.gasPrice || minMaxFee;

    const latestBlock = await this.provider.getBlock('latest');
    const baseFee = latestBlock?.baseFeePerGas;
    if (baseFee) {
      const targetMaxFee = baseFee.mul(2).add(maxPriority);
      if (maxFee.lt(targetMaxFee)) {
        maxFee = targetMaxFee;
      }
    }

    if (maxPriority.lt(minPriority)) maxPriority = minPriority;
    if (maxFee.lt(minMaxFee)) maxFee = minMaxFee;
    if (maxFee.lt(maxPriority)) maxFee = maxPriority;

    return { maxPriorityFeePerGas: maxPriority, maxFeePerGas: maxFee };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
