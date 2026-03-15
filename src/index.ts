import { config, validateConfig } from './config.js';
import { TradeMonitor } from './monitor.js';
import { WebSocketMonitor } from './websocket-monitor.js';
import type { Trade } from './monitor.js';
import { TradeExecutor } from './trader.js';
import { PositionTracker } from './positions.js';
import { RiskManager } from './risk-manager.js';
import { Redeemer } from './redeemer.js';
import { logger } from './logger.js';

class PolymarketCopyBot {
  private monitor: TradeMonitor;
  private wsMonitor?: WebSocketMonitor;
  private executor: TradeExecutor;
  private positions: PositionTracker;
  private risk: RiskManager;
  private redeemer?: Redeemer;
  private isRunning: boolean = false;
  private processedTrades: Set<string> = new Set();
  private botStartTime: number = 0;
  private readonly maxProcessedTrades = 10000;
  private stats = {
    tradesDetected: 0,
    tradesCopied: 0,
    tradesFailed: 0,
    totalVolume: 0,
  };

  // Aggregation: buffer trades per conditionId (market), flush after window expires
  private pendingAggregations: Map<string, { trades: Trade[]; timer: NodeJS.Timeout }> = new Map();

  constructor() {
    this.monitor = new TradeMonitor();
    this.executor = new TradeExecutor();
    this.positions = new PositionTracker();
    this.risk = new RiskManager(this.positions);
  }
  
  async initialize(): Promise<void> {
    logger.info('🤖 Polymarket Copy Trading Bot');
    logger.info('================================');
    logger.info(`Target wallet: ${config.targetWallet}`);
    logger.info(`Position multiplier: ${config.trading.positionSizeMultiplier * 100}%`);
    logger.info(`Max trade size: ${config.trading.maxTradeSize} USDC`);
    logger.info(`Order type: ${config.trading.orderType}`);
    logger.info(`Copy sells: ${config.trading.copySells ? 'Yes' : 'No (BUY only)'}`);
    logger.info(`Min target trade size: ${config.trading.minCopyUsdc} USDC`);
    if (config.trading.minCopyPrice > 0 || config.trading.maxCopyPrice < 1) {
      logger.info(`Price filter: [${config.trading.minCopyPrice}, ${config.trading.maxCopyPrice}]`);
    }
    if (config.trading.excludedSlugPatterns.length > 0) {
      logger.info(`Excluded slug patterns: ${config.trading.excludedSlugPatterns.join(', ')}`);
    }
    if (config.trading.aggregationWindowMs > 0) {
      logger.info(`Aggregation window: ${config.trading.aggregationWindowMs}ms (net-directional)`);
    }
    if (config.trading.maxPriceDeviation > 0) {
      logger.info(`Max price deviation: ${(config.trading.maxPriceDeviation * 100).toFixed(0)}%`);
    }
    if (config.trading.copyOutcomeSide !== 'both') {
      logger.info(`Copy outcome side: ${config.trading.copyOutcomeSide} (skip other side of hedges)`);
    }
    logger.info(`WebSocket: ${config.monitoring.useWebSocket ? 'Enabled' : 'Disabled'}`);
    if (config.risk.maxSessionNotional > 0 || config.risk.maxPerMarketNotional > 0) {
      logger.info(`Risk caps: session=${config.risk.maxSessionNotional || '∞'} USDC, per-market=${config.risk.maxPerMarketNotional || '∞'} USDC`);
    }
    logger.info(`Auth mode: EOA (signature type 0)`);
    logger.info('================================\n');

    validateConfig();

    this.botStartTime = Date.now();
    logger.info(`⏰ Bot start time: ${new Date(this.botStartTime).toISOString()}`);
    logger.info('   (Only trades after this time will be copied)\n');

    await this.monitor.initialize();
    await this.executor.initialize();
    await this.reconcilePositions();

    if (config.monitoring.useWebSocket) {
      this.wsMonitor = new WebSocketMonitor();
      try {
        const wsAuth = this.executor.getWsAuth();
        const channel = config.monitoring.useUserChannel ? 'user' : 'market';
        await this.wsMonitor.initialize(this.handleNewTrade.bind(this), channel, wsAuth);
        logger.info(`✅ WebSocket monitor initialized (${channel} channel)\n`);

        if (channel === 'market' && config.monitoring.wsAssetIds.length > 0) {
          for (const assetId of config.monitoring.wsAssetIds) {
            await this.wsMonitor.subscribeToMarket(assetId);
          }
        }

        if (channel === 'user' && config.monitoring.wsMarketIds.length > 0) {
          for (const marketId of config.monitoring.wsMarketIds) {
            await this.wsMonitor.subscribeToCondition(marketId);
          }
        }
      } catch (error) {
        logger.error('⚠️  WebSocket initialization failed, falling back to REST API only');
        logger.error('   Error:', String(error));
        delete this.wsMonitor;
      }
    }

    // Start background redeemer if enabled
    if (config.redeemer.enabled) {
      this.redeemer = new Redeemer();
      // Fire and forget — runs in background
      this.redeemer.start().catch(err => {
        logger.error(`[REDEEMER] Fatal error: ${err.message}`);
      });
    }
  }
  
  async start(): Promise<void> {
    this.isRunning = true;
    const monitoringMethods = [];
    if (this.wsMonitor) monitoringMethods.push('WebSocket');
    monitoringMethods.push('REST API');

    logger.info(`🚀 Bot started! Monitoring via: ${monitoringMethods.join(' + ')}\n`);

    while (this.isRunning) {
      try {
        await this.monitor.pollForNewTrades(this.handleNewTrade.bind(this));
        this.monitor.pruneProcessedHashes();
      } catch (error) {
        logger.error('Error in monitoring loop:', String(error));
      }

      await this.sleep(config.monitoring.pollInterval);
    }
  }
  
  private async handleNewTrade(trade: Trade): Promise<void> {
    if (trade.timestamp && trade.timestamp < this.botStartTime) {
      return;
    }

    const tradeKeys = this.getTradeKeys(trade);
    if (tradeKeys.some((key) => this.processedTrades.has(key))) {
      return;
    }

    for (const key of tradeKeys) {
      this.processedTrades.add(key);
    }
    this.pruneProcessedTrades();
    this.stats.tradesDetected++;

    logger.info('\n' + '='.repeat(50));
    logger.info(`🎯 NEW TRADE DETECTED`);
    logger.info(`   Time: ${new Date(trade.timestamp).toISOString()}`);
    logger.info(`   Market: ${trade.market}`);
    logger.info(`   Side: ${trade.side} ${trade.outcome}`);
    logger.info(`   Size: ${trade.size} USDC @ ${trade.price.toFixed(3)}`);
    logger.info(`   Token ID: ${trade.tokenId}`);
    logger.info('='.repeat(50));

    if (trade.side === 'SELL' && !config.trading.copySells) {
      logger.warn('⚠️  Skipping SELL trade (COPY_SELLS=false, BUY-only mode)');
      return;
    }

    // Filter: target entry price range (skip cheap hedges / overpriced entries)
    if (trade.price < config.trading.minCopyPrice || trade.price > config.trading.maxCopyPrice) {
      logger.warn(`⚠️  Skipping trade: price ${trade.price.toFixed(3)} outside allowed range [${config.trading.minCopyPrice}, ${config.trading.maxCopyPrice}]`);
      return;
    }

    // Filter: excluded slug patterns (e.g. skip 5-minute markets)
    if (trade.slug && config.trading.excludedSlugPatterns.length > 0) {
      const slugLower = trade.slug.toLowerCase();
      const matchedPattern = config.trading.excludedSlugPatterns.find(p => slugLower.includes(p.toLowerCase()));
      if (matchedPattern) {
        logger.warn(`⚠️  Skipping trade: slug "${trade.slug}" matches excluded pattern "${matchedPattern}"`);
        return;
      }
    }

    // Aggregation: if enabled, buffer BUY trades per conditionId and flush after window.
    // MIN_COPY_USDC is checked AFTER aggregation (in flushAggregation) so small fills
    // that combine into a meaningful position are not prematurely rejected.
    const aggWindow = config.trading.aggregationWindowMs;
    if (aggWindow > 0 && trade.side === 'BUY') {
      const conditionId = trade.market; // conditionId

      // Instant-execute: if a single fill already exceeds MIN_COPY_USDC, skip aggregation
      // to minimize latency on fast-resolving markets
      if (trade.size >= config.trading.minCopyUsdc && !this.pendingAggregations.has(conditionId)) {
        logger.info(`   ⚡ Single fill $${trade.size.toFixed(2)} >= MIN_COPY_USDC — executing immediately (skipping aggregation)`);
        await this.executeTrade(trade);
        return;
      }

      const existing = this.pendingAggregations.get(conditionId);
      if (existing) {
        existing.trades.push(trade);
        // Sliding window: reset the timer on each new trade so we capture the full burst
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => {
          this.flushAggregation(conditionId).catch(err => {
            logger.error(`❌ Aggregation flush failed for ${conditionId.substring(0, 10)}...: ${err?.message || err}`);
          });
        }, aggWindow);
        logger.info(`   ⏳ Buffered into aggregation (${existing.trades.length} trades for ${conditionId.substring(0, 10)}...)`);
        return;
      }
      // Start new aggregation window
      const agg = {
        trades: [trade],
        timer: setTimeout(() => {
          this.flushAggregation(conditionId).catch(err => {
            logger.error(`❌ Aggregation flush failed for ${conditionId.substring(0, 10)}...: ${err?.message || err}`);
          });
        }, aggWindow),
      };
      this.pendingAggregations.set(conditionId, agg);
      logger.info(`   ⏳ Started ${aggWindow}ms aggregation window for ${conditionId.substring(0, 10)}...`);
      return;
    }

    // For non-aggregated trades (SELL, or aggregation disabled), check min size here
    if (trade.size < config.trading.minCopyUsdc) {
      logger.warn(`⚠️  Skipping trade: size $${trade.size.toFixed(2)} below MIN_COPY_USDC ($${config.trading.minCopyUsdc})`);
      return;
    }

    await this.executeTrade(trade);
  }

  /**
   * Flush aggregated trades for a conditionId.
   * Computes the net directional BUY, applying one-side-only filtering.
   */
  private async flushAggregation(conditionId: string): Promise<void> {
    const agg = this.pendingAggregations.get(conditionId);
    this.pendingAggregations.delete(conditionId);
    if (!agg || agg.trades.length === 0) {
      logger.info(`🔀 Aggregation flush for ${conditionId.substring(0, 10)}... — nothing to flush`);
      return;
    }

    logger.info(`\n🔀 AGGREGATION FLUSH (${conditionId.substring(0, 10)}...) — ${agg.trades.length} buffered trades`);

    // Group by tokenId to see if target bet on both sides
    const byToken: Map<string, { totalUsdc: number; weightedPrice: number; trades: Trade[] }> = new Map();
    for (const t of agg.trades) {
      const existing = byToken.get(t.tokenId);
      if (existing) {
        existing.weightedPrice = (existing.weightedPrice * existing.totalUsdc + t.price * t.size) / (existing.totalUsdc + t.size);
        existing.totalUsdc += t.size;
        existing.trades.push(t);
      } else {
        byToken.set(t.tokenId, { totalUsdc: t.size, weightedPrice: t.price, trades: [t] });
      }
    }

    const sides = Array.from(byToken.entries());
    const copyOutcomeSide = config.trading.copyOutcomeSide.toLowerCase();

    if (sides.length > 1 && copyOutcomeSide !== 'both') {
      // Target hedged both sides — pick only the larger (net) side
      sides.sort((a, b) => b[1].totalUsdc - a[1].totalUsdc);
      const winner = sides[0]!;
      const winnerData = winner[1];
      const winnerTrade = winnerData.trades[0]!;
      const loserTotal = sides.slice(1).reduce((s, [, d]) => s + d.totalUsdc, 0);
      const netUsdc = winnerData.totalUsdc - loserTotal;

      logger.info(`\n🔀 AGGREGATION FLUSH (${conditionId.substring(0, 10)}...)`);
      logger.info(`   Target bet BOTH sides: ${sides.map(([, d]) => `$${d.totalUsdc.toFixed(2)}`).join(' vs ')}`);
      logger.info(`   Net directional: ${winnerTrade.outcome} $${netUsdc.toFixed(2)}`);

      if (netUsdc < config.trading.minCopyUsdc) {
        logger.warn(`   ⚠️  Net size $${netUsdc.toFixed(2)} below minimum — skipping hedged market`);
        return;
      }

      // Build a synthetic trade for the net directional position
      const syntheticTrade: Trade = {
        txHash: winnerTrade.txHash,
        timestamp: winnerTrade.timestamp,
        market: winnerTrade.market,
        tokenId: winnerTrade.tokenId,
        side: winnerTrade.side,
        outcome: winnerTrade.outcome,
        size: netUsdc,
        price: winnerData.weightedPrice,
      };
      if (winnerTrade.slug !== undefined) syntheticTrade.slug = winnerTrade.slug;
      if (winnerTrade.title !== undefined) syntheticTrade.title = winnerTrade.title;
      await this.executeTrade(syntheticTrade);
    } else {
      // Not hedged or copyOutcomeSide='both' — execute each side
      logger.info(`\n🔀 AGGREGATION FLUSH (${conditionId.substring(0, 10)}...) — ${sides.length} side(s)`);
      for (const [, data] of sides) {
        // Apply MIN_COPY_USDC to the aggregated total, not individual fills
        if (data.totalUsdc < config.trading.minCopyUsdc) {
          logger.warn(`   ⚠️  Aggregated size $${data.totalUsdc.toFixed(2)} below MIN_COPY_USDC — skipping`);
          continue;
        }
        const base = data.trades[0]!;
        const representativeTrade: Trade = {
          txHash: base.txHash,
          timestamp: base.timestamp,
          market: base.market,
          tokenId: base.tokenId,
          side: base.side,
          outcome: base.outcome,
          size: data.totalUsdc,
          price: data.weightedPrice,
        };
        if (base.slug !== undefined) representativeTrade.slug = base.slug;
        if (base.title !== undefined) representativeTrade.title = base.title;
        await this.executeTrade(representativeTrade);
      }
    }
  }

  /**
   * Execute a single trade with price-staleness guard and risk checks.
   */
  private async executeTrade(trade: Trade): Promise<void> {
    const copyNotional = this.executor.calculateCopySize(trade.size);

    // Price-staleness guard: check if current market price has moved too far from target's fill
    // Uses absolute price difference (not percentage) — suited for binary 0→1 markets
    const maxDeviation = config.trading.maxPriceDeviation;
    if (maxDeviation > 0 && trade.side === 'BUY') {
      try {
        const currentPrice = await this.executor.getCurrentPrice(trade.tokenId, trade.side);
        if (currentPrice !== null) {
          const absoluteDiff = currentPrice - trade.price;
          if (absoluteDiff > maxDeviation) {
            logger.warn(`⚠️  Skipping trade: price moved +${absoluteDiff.toFixed(3)} since target's fill (${trade.price.toFixed(3)} → ${currentPrice.toFixed(3)}, max ${maxDeviation.toFixed(2)})`);
            return;
          }
        }
      } catch {
        // If we can't check, proceed with the trade
      }
    }

    if (trade.side === 'SELL') {
      const copyShares = this.executor.calculateSharesForNotional(copyNotional, trade.price);
      let position = this.positions.getPosition(trade.tokenId);

      // If local tracker doesn't have enough shares, refresh from Data API
      if (!position || position.shares < copyShares) {
        logger.info(`   Refreshing positions from Data API before sell check...`);
        await this.reconcilePositions();
        position = this.positions.getPosition(trade.tokenId);
      }

      if (!position || position.shares < copyShares) {
        logger.warn(`⚠️  Skipping SELL trade: insufficient position (have ${position?.shares?.toFixed(4) ?? 0}, need ${copyShares.toFixed(4)} shares)`);
        return;
      }
    }

    if (this.wsMonitor) {
      await this.wsMonitor.subscribeToMarket(trade.tokenId);
    }
    const riskCheck = this.risk.checkTrade(trade, copyNotional);
    if (!riskCheck.allowed) {
      logger.warn(`⚠️  Risk check blocked trade: ${riskCheck.reason}`);
      return;
    }

    try {
      const result = await this.executor.executeCopyTrade(trade, copyNotional);
      this.risk.recordFill({
        trade,
        notional: result.copyNotional,
        shares: result.copyShares,
        price: result.price,
        side: result.side,
      });
      this.stats.tradesCopied++;
      this.stats.totalVolume += result.copyNotional;
      logger.info(`✅ Successfully copied trade!`);
      logger.info(`📊 Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`);

      if (config.run.exitAfterFirstSellCopy && result.side === 'SELL') {
        logger.info('\n🎯 EXIT_AFTER_FIRST_SELL_COPY: First SELL copied successfully. Exiting.');
        this.stop();
        process.exit(0);
      }
    } catch (error: any) {
      this.stats.tradesFailed++;
      logger.error(`❌ Failed to copy trade`);
      if (error?.message) {
        logger.error(`   Reason: ${error.message}`);
      }
      logger.info(`📊 Session Stats: ${this.stats.tradesCopied}/${this.stats.tradesDetected} copied, ${this.stats.tradesFailed} failed`);
    }
  }

  private async reconcilePositions(): Promise<void> {
    try {
      const positions = await this.executor.getPositions();
      if (!positions || positions.length === 0) {
        logger.info('🧾 Positions: none found (fresh session)');
        return;
      }

      const { loaded, skipped } = this.positions.loadFromClobPositions(positions);
      const totalNotional = this.positions.getTotalNotional();
      logger.info(`🧾 Positions loaded: ${loaded} (skipped ${skipped}), total notional ≈ ${totalNotional.toFixed(2)} USDC`);
    } catch (error: any) {
      logger.warn(`🧾 Positions reconciliation failed: ${error.message || 'Unknown error'}`);
    }
  }
  
  stop(): void {
    this.isRunning = false;

    // Clear pending aggregation timers
    for (const [, agg] of this.pendingAggregations) {
      clearTimeout(agg.timer);
    }
    this.pendingAggregations.clear();

    if (this.wsMonitor) {
      this.wsMonitor.close();
    }

    if (this.redeemer) {
      this.redeemer.stop();
    }

    logger.info('\n🛑 Bot stopped');
    this.printStats();
  }
  
  printStats(): void {
    logger.info('\n📊 Session Statistics:');
    logger.info(`   Trades detected: ${this.stats.tradesDetected}`);
    logger.info(`   Trades copied: ${this.stats.tradesCopied}`);
    logger.info(`   Trades failed: ${this.stats.tradesFailed}`);
    logger.info(`   Total volume: ${this.stats.totalVolume.toFixed(2)} USDC`);
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getTradeKeys(trade: Trade): string[] {
    const keys: string[] = [];

    if (trade.txHash) {
      keys.push(trade.txHash);
    }

    const fallbackKey = `${trade.tokenId}|${trade.side}|${trade.size}|${trade.price}|${trade.timestamp}`;
    keys.push(fallbackKey);

    return keys;
  }

  private pruneProcessedTrades(): void {
    if (this.processedTrades.size <= this.maxProcessedTrades) {
      return;
    }

    const entries = Array.from(this.processedTrades);
    this.processedTrades = new Set(entries.slice(-Math.floor(this.maxProcessedTrades / 2)));
  }
}

async function main() {
  const bot = new PolymarketCopyBot();
  
  process.on('SIGINT', () => {
    logger.info('\n\nReceived SIGINT, shutting down...');
    bot.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    bot.stop();
    process.exit(0);
  });
  
  try {
    await bot.initialize();
    await bot.start();
  } catch (error) {
    logger.fatal('Fatal error:', String(error));
    process.exit(1);
  }
}

main();
