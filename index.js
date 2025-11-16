// index.js — Entry price (ponderado) + Current MCAP por reservas + PnL — ethers v6
import 'dotenv/config';
import fs from 'node:fs';
import chalk from 'chalk';
import { ethers } from 'ethers';

// ====== ENV & helpers ======
const {
  MANTLE_RPC,
  WALLET,
  TOKEN,
  FROM_BLOCK,
  TO_BLOCK,
  CHUNK,
  TOTAL_SUPPLY,
  MNT_USD_PRICE,
  WMNT,
  FACTORY,
  CURRENT_PRICE_LOOKBACK,
  CURRENT_PRICE_MODE,
  CURRENT_PRICE_TX,
  ENTRY_CACHE_FILE,
} = process.env;

if (!MANTLE_RPC || !WALLET || !TOKEN) {
  console.error('Faltan variables en .env: MANTLE_RPC, WALLET, TOKEN');
  process.exit(1);
}

const addr = (s) => ethers.getAddress(String(s).toLowerCase());
const provider = new ethers.JsonRpcProvider(MANTLE_RPC);

const WALLET_ADDR = addr(WALLET);
const TOKEN_ADDR  = addr(TOKEN);

const START_BLOCK   = FROM_BLOCK && FROM_BLOCK !== '' ? (FROM_BLOCK === 'latest' ? 'latest' : parseInt(FROM_BLOCK,10)) : 1;
const END_BLOCK     = TO_BLOCK && TO_BLOCK !== '' ? (TO_BLOCK === 'latest' ? 'latest' : parseInt(TO_BLOCK,10)) : 'latest';
const DEFAULT_CHUNK = CHUNK ? Math.max(100, parseInt(CHUNK,10)) : 2000;
const SUPPLY        = TOTAL_SUPPLY ? Number(TOTAL_SUPPLY) : 1_000_000_000; // FDV por defecto 1B
const MNT_USD       = MNT_USD_PRICE ? Number(MNT_USD_PRICE) : null;
const LOOKBACK      = CURRENT_PRICE_LOOKBACK ? Math.max(500, parseInt(CURRENT_PRICE_LOOKBACK,10)) : 10_000;
const PRICE_MODE    = (CURRENT_PRICE_MODE || 'pool_reserves').toLowerCase();
const CACHE_FILE    = ENTRY_CACHE_FILE || 'entry_cache.json';

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)'
];
const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address)'
];
const PAIR_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
];

const r2  = (x) => (x == null ? null : Number(x).toFixed(2));

function loadEntryCache(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { version: 1, entries: {} };
    }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object') {
      return { version: 1, entries: {} };
    }
    if (!raw.entries || typeof raw.entries !== 'object') {
      raw.entries = {};
    }
    return raw;
  } catch (e) {
    console.warn(chalk.yellow(`No se pudo leer caché ${filePath}, usando uno vacío: ${e?.message || e}`));
    return { version: 1, entries: {} };
  }
}

function saveEntryCache(filePath, cache) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.warn(chalk.yellow(`No se pudo guardar caché ${filePath}: ${e?.message || e}`));
  }
}

function getCacheKey(wallet, token) {
  return `${wallet.toLowerCase()}__${token.toLowerCase()}`;
}

function computeBlockBounds(entries) {
  if (!entries || entries.length === 0) {
    return { min: null, max: null };
  }
  let min = entries[0].blockNumber ?? null;
  let max = entries[0].blockNumber ?? null;
  for (const en of entries) {
    if (typeof en.blockNumber !== 'number') continue;
    if (min == null || en.blockNumber < min) min = en.blockNumber;
    if (max == null || en.blockNumber > max) max = en.blockNumber;
  }
  return { min, max };
}

// ====== Formato lindo ======
function printPretty(fullOut) {
  const entryMcapPretty =
    fullOut.weightedFDV_USD != null
      ? `${r2(fullOut.weightedFDV_USD)} USD`
      : fullOut.weightedFDV_MNT != null
      ? `${r2(fullOut.weightedFDV_MNT)} MNT`
      : '—';

  const currentMcapPretty =
    fullOut.currentFDV_USD != null
      ? `${r2(fullOut.currentFDV_USD)} USD`
      : fullOut.currentFDV_MNT != null
      ? `${r2(fullOut.currentFDV_MNT)} MNT`
      : '—';

  const pnlColor =
    (fullOut.pnl_percent ?? 0) > 0
      ? chalk.green
      : (fullOut.pnl_percent ?? 0) < 0
      ? chalk.red
      : chalk.gray;

  const sign = (v) => (v > 0 ? '+' : v < 0 ? '' : '');

  const pnlText =
    fullOut.pnl_MNT != null
      ? `${sign(fullOut.pnl_MNT)}${r2(fullOut.pnl_MNT)} MNT / ${sign(fullOut.pnl_USD ?? 0)}${r2(fullOut.pnl_USD ?? 0)} USD  (${sign(fullOut.pnl_percent ?? 0)}${r2(fullOut.pnl_percent ?? 0)}%)`
      : '—';

  console.log(chalk.gray('\n' + '═'.repeat(60)));
  console.log(chalk.bold('               📊 RESULT SUMMARY'));
  console.log(chalk.gray('═'.repeat(60)));
  console.log(`${chalk.bold('  Buys detected:')} ${chalk.white(fullOut.buysDetected)}`);
  console.log(`${chalk.bold('  Entry MCAP:   ')} ${chalk.cyanBright(entryMcapPretty)}`);
  console.log(`${chalk.bold('  Current MCAP: ')} ${chalk.cyanBright(currentMcapPretty)}`);
  console.log(`${chalk.bold('  PNL:          ')} ${pnlColor(pnlText)}`);
  console.log(chalk.gray('═'.repeat(60)) + '\n');
}

function saveResults(fullOut) {
  try {
    fs.writeFileSync('entry_price_results.json', JSON.stringify(fullOut, null, 2));
    console.log(chalk.gray('💾 Guardado en entry_price_results.json'));
  } catch (e) {
    console.error(chalk.red('❌ No se pudo guardar entry_price_results.json:'), e?.message || e);
  }
}

// ====== Precio actual por reservas (pool TOKEN/WMNT) ======
async function getCurrentPrice_fromReserves(tokenAddr, tokenDecimals) {
  if (!WMNT || !FACTORY) return { priceMNTPerToken: null, source: { mode: 'pool_reserves', reason: 'WMNT/FACTORY missing' } };
  const WMNT_ADDR = addr(WMNT);
  const FACTORY_ADDR = addr(FACTORY);

  try {
    const factory = new ethers.Contract(FACTORY_ADDR, FACTORY_ABI, provider);
    const pairAddr = await factory.getPair(tokenAddr, WMNT_ADDR);
    if (!pairAddr || pairAddr === ethers.ZeroAddress) {
      return { priceMNTPerToken: null, source: { mode: 'pool_reserves', reason: 'pair not found' } };
    }
    const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
    const [t0, t1, reserves] = await Promise.all([pair.token0(), pair.token1(), pair.getReserves()]);
    const token0 = addr(t0), token1 = addr(t1);
    const { reserve0, reserve1 } = reserves;

    // precio en MNT por 1 TOKEN
    let price;
    if (token0.toLowerCase() === tokenAddr.toLowerCase()) {
      // TOKEN/WMNT
      price = Number(ethers.formatUnits(reserve1, 18)) / Number(ethers.formatUnits(reserve0, tokenDecimals));
    } else if (token1.toLowerCase() === tokenAddr.toLowerCase()) {
      // WMNT/TOKEN
      price = Number(ethers.formatUnits(reserve0, 18)) / Number(ethers.formatUnits(reserve1, tokenDecimals));
    } else {
      return { priceMNTPerToken: null, source: { mode: 'pool_reserves', reason: 'token not in pair' } };
    }

    return { priceMNTPerToken: price, source: { mode: 'pool_reserves', pair: pairAddr } };
  } catch (e) {
    return { priceMNTPerToken: null, source: { mode: 'pool_reserves', error: e?.message || String(e) } };
  }
}

// ====== Fallbacks: network last buy / tx hash ======
async function getCurrentPrice_networkLastBuy(tokenAddr, tokenDecimals, lookbackBlocks) {
  const latest = await provider.getBlockNumber();
  const from = Math.max(1, latest - lookbackBlocks);
  const to   = latest;

  const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
  let chunk = 2000, end = to;

  while (end >= from) {
    const start = Math.max(from, end - chunk + 1);
    const filter = { address: tokenAddr, fromBlock: start, toBlock: end, topics: [TRANSFER_TOPIC] };
    try {
      const logs = await provider.getLogs(filter);
      for (let i = logs.length - 1; i >= 0; i--) {
        const lg = logs[i];
        const tokenAmountRaw = BigInt(lg.data);
        if (tokenAmountRaw <= 0n) continue;

        const tx = await provider.getTransaction(lg.transactionHash);
        const mntValueRaw = BigInt(tx.value ?? 0n);
        if (mntValueRaw > 0n) {
          const price = Number(ethers.formatUnits(mntValueRaw, 18)) / Number(ethers.formatUnits(tokenAmountRaw, tokenDecimals));
          return { priceMNTPerToken: price, source: { mode: 'network_last_buy', txHash: lg.transactionHash, blockNumber: lg.blockNumber } };
        }
      }
      end = start - 1;
    } catch (e) {
      const msg = (e?.error?.message || e?.message || '').toLowerCase();
      if (msg.includes('eth_getlogs is limited') || msg.includes('range') || msg.includes('more than')) {
        if (chunk > 200) { chunk = Math.floor(chunk / 2); continue; }
        return { priceMNTPerToken: null, source: { mode: 'network_last_buy', reason: 'rpc limited' } };
      } else {
        return { priceMNTPerToken: null, source: { mode: 'network_last_buy', error: e?.message || String(e) } };
      }
    }
  }
  return { priceMNTPerToken: null, source: { mode: 'network_last_buy', reason: 'not found in lookback' } };
}

async function getCurrentPrice_fromTxHash(txHash, tokenAddr, tokenDecimals) {
  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) return { priceMNTPerToken: null, source: { mode: 'tx_hash', reason: 'tx not found', txHash } };
    const rc = await provider.getTransactionReceipt(txHash);
    if (!rc || !rc.logs) return { priceMNTPerToken: null, source: { mode: 'tx_hash', reason: 'no receipt/logs', txHash } };

    const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
    let tokenAmountRaw = 0n;
    for (const lg of rc.logs) {
      if ((lg.address || '').toLowerCase() === tokenAddr.toLowerCase() && lg.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC.toLowerCase()) {
        const amt = BigInt(lg.data);
        if (amt > 0n) { tokenAmountRaw = amt; break; }
      }
    }
    if (tokenAmountRaw === 0n) return { priceMNTPerToken: null, source: { mode: 'tx_hash', reason: 'no token Transfer', txHash } };

    const mntValueRaw = BigInt(tx.value ?? 0n);
    if (mntValueRaw <= 0n) return { priceMNTPerToken: null, source: { mode: 'tx_hash', reason: 'no native value', txHash } };

    const price = Number(ethers.formatUnits(mntValueRaw, 18)) / Number(ethers.formatUnits(tokenAmountRaw, tokenDecimals));
    return { priceMNTPerToken: price, source: { mode: 'tx_hash', txHash, blockNumber: rc.blockNumber } };
  } catch (e) {
    return { priceMNTPerToken: null, source: { mode: 'tx_hash', error: e?.message || String(e), txHash } };
  }
}

// ====== Core ======
async function main() {
  const erc = new ethers.Contract(TOKEN_ADDR, ERC20_ABI, provider);
  const [decimals, symbol, walletBalRaw] = await Promise.all([
    erc.decimals().catch(() => 18),
    erc.symbol().catch(() => 'TOKEN'),
    erc.balanceOf(WALLET_ADDR).catch(() => 0n)
  ]);
  const walletBal = Number(ethers.formatUnits(walletBalRaw, decimals));

  console.log('Token meta:', { address: TOKEN_ADDR, symbol, decimals });

  const latest = await provider.getBlockNumber();
  const fromBlock = START_BLOCK === 'latest' ? latest : START_BLOCK;
  const toBlock   = END_BLOCK   === 'latest' ? latest : END_BLOCK;

  const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
  const toTopic = ethers.zeroPadValue(WALLET_ADDR, 32).toLowerCase();

  console.log(`Fetching logs (paginated) for token ${TOKEN_ADDR}`);
  console.log(`Range: ${fromBlock} -> ${toBlock} (chunk ${DEFAULT_CHUNK})`);
  console.log(`Filter: Transfer to wallet ${WALLET_ADDR}`);

  const entryCache = loadEntryCache(CACHE_FILE);
  if (!entryCache.entries) entryCache.entries = {};
  const cacheKey = getCacheKey(WALLET_ADDR, TOKEN_ADDR);
  const cachedRecord = entryCache.entries[cacheKey];
  let cacheEntries = Array.isArray(cachedRecord?.entries) ? cachedRecord.entries.slice() : [];
  const bounds = {
    min: typeof cachedRecord?.minBlock === 'number' ? cachedRecord.minBlock : null,
    max: typeof cachedRecord?.maxBlock === 'number' ? cachedRecord.maxBlock : null
  };
  if (bounds.min == null || bounds.max == null) {
    const computed = computeBlockBounds(cacheEntries);
    if (bounds.min == null) bounds.min = computed.min;
    if (bounds.max == null) bounds.max = computed.max;
  }

  let entries = cacheEntries
    .filter((en) => typeof en.blockNumber === 'number' && en.blockNumber >= fromBlock && en.blockNumber <= toBlock)
    .map((en) => ({ ...en }));
  const reusedFromCache = entries.length;
  if (reusedFromCache > 0) {
    console.log(`[Cache] Reaprovechadas ${reusedFromCache} entradas almacenadas (bloques ${fromBlock}-${toBlock}).`);
  }

  const intervals = [];
  const hasCacheRange = bounds.min != null && bounds.max != null && cacheEntries.length > 0;
  if (!hasCacheRange) {
    intervals.push({ start: fromBlock, end: toBlock });
  } else {
    if (fromBlock < bounds.min) {
      intervals.push({ start: fromBlock, end: Math.min(bounds.min - 1, toBlock) });
    }
    if (toBlock > bounds.max) {
      intervals.push({ start: Math.max(bounds.max + 1, fromBlock), end: toBlock });
    }
  }
  const rangesToFetch = intervals.filter((r) => r.start != null && r.end != null && r.end >= r.start);
  if (!rangesToFetch.length && reusedFromCache > 0) {
    console.log('[Cache] Rango totalmente cubierto, no es necesario llamar a getLogs.');
  }

  let chunk = DEFAULT_CHUNK;
  let totalLogsFromRpc = 0;
  let cacheUpdated = false;

  async function fetchRange(rangeStart, rangeEnd) {
    if (rangeStart > rangeEnd) return;
    let currentStart = rangeStart;
    while (currentStart <= rangeEnd) {
      const currentEnd = Math.min(currentStart + chunk - 1, rangeEnd);
      const filter = { address: TOKEN_ADDR, fromBlock: currentStart, toBlock: currentEnd, topics: [TRANSFER_TOPIC, null, toTopic] };

      try {
        const logs = await provider.getLogs(filter);
        totalLogsFromRpc += logs.length;

        for (const lg of logs) {
          const tokenReceivedRaw = BigInt(lg.data);
          const tokenReceived = Number(ethers.formatUnits(tokenReceivedRaw, decimals));

          const tx = await provider.getTransaction(lg.transactionHash);
          const mntPaidRaw = BigInt(tx.value ?? 0n);
          const mntPaid = Number(ethers.formatUnits(mntPaidRaw, 18));

          const entry =
            mntPaidRaw > 0n && tokenReceivedRaw > 0n
              ? {
                  type: 'buy',
                  txHash: lg.transactionHash,
                  blockNumber: lg.blockNumber,
                  mntPaidRaw: mntPaidRaw.toString(),
                  mntPaid,
                  tokenReceivedRaw: tokenReceivedRaw.toString(),
                  tokenReceived
                }
              : {
                  type: 'transfer-only',
                  txHash: lg.transactionHash,
                  blockNumber: lg.blockNumber,
                  tokenReceivedRaw: tokenReceivedRaw.toString(),
                  tokenReceived,
                  note: 'No native MNT value observed in tx; price unknown.'
                };

          entries.push(entry);
          cacheEntries.push(entry);
          cacheUpdated = true;
        }

        console.log(` OK ${currentStart}-${currentEnd} (+${logs.length}) totalRPC=${totalLogsFromRpc}`);
        currentStart = currentEnd + 1;
      } catch (e) {
        const msg = (e?.error?.message || e?.message || '').toLowerCase();
        if (msg.includes('eth_getlogs is limited') || msg.includes('range') || msg.includes('more than')) {
          if (chunk > 100) {
            chunk = Math.floor(chunk / 2);
            console.log(`RPC limit hit. Reducing chunk to ${chunk} and retrying...`);
            continue;
          } else {
            console.error('RPC sigue limitando incluso con chunk=100. Abortando.');
            throw e;
          }
        } else {
          console.error('Error getLogs:', e);
          throw e;
        }
      }
    }
  }

  for (const range of rangesToFetch) {
    console.log(`[Cache] Escaneando nuevo bloque ${range.start}-${range.end}`);
    await fetchRange(range.start, range.end);
  }

  if (cacheUpdated) {
    cacheEntries.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
      if (a.txHash !== b.txHash) return (a.txHash || '').localeCompare(b.txHash || '');
      return (a.tokenReceivedRaw || '').localeCompare(b.tokenReceivedRaw || '');
    });
    const dedupCache = [];
    const seenCache = new Set();
    for (const en of cacheEntries) {
      const k = `${en.blockNumber}-${en.txHash}-${en.tokenReceivedRaw}-${en.mntPaidRaw ?? '0'}-${en.type}`;
      if (seenCache.has(k)) continue;
      dedupCache.push(en);
      seenCache.add(k);
    }
    cacheEntries = dedupCache;
    const { min: newMin, max: newMax } = computeBlockBounds(cacheEntries);
    entryCache.entries[cacheKey] = {
      wallet: WALLET_ADDR,
      token: TOKEN_ADDR,
      minBlock: newMin,
      maxBlock: newMax,
      updatedAt: Date.now(),
      entries: cacheEntries
    };
    saveEntryCache(CACHE_FILE, entryCache);
    console.log(`[Cache] Persistidas ${cacheEntries.length} entradas (${newMin}-${newMax}) en ${CACHE_FILE}.`);
  }

  entries.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    if (a.txHash !== b.txHash) return (a.txHash || '').localeCompare(b.txHash || '');
    return (a.tokenReceivedRaw || '').localeCompare(b.tokenReceivedRaw || '');
  });
  const dedupEntries = [];
  const seenEntries = new Set();
  for (const en of entries) {
    const key = `${en.blockNumber}-${en.txHash}-${en.tokenReceivedRaw}-${en.mntPaidRaw ?? '0'}-${en.type}`;
    if (seenEntries.has(key)) continue;
    dedupEntries.push(en);
    seenEntries.add(key);
  }
  entries = dedupEntries;

  console.log(`Done. Logs reutilizados: ${reusedFromCache}, nuevos descargados: ${totalLogsFromRpc}, total analizados: ${entries.length}`);

  // Ponderado (entrada)
  let buysDetected = 0;
  let transfersNoPrice = 0;
  let sumTokensRaw = 0n;
  let sumMntRaw = 0n;

  for (const en of entries) {
    if (en.type === 'buy') {
      buysDetected++;
      sumTokensRaw += BigInt(en.tokenReceivedRaw);
      sumMntRaw += BigInt(en.mntPaidRaw);
    } else {
      transfersNoPrice++;
    }
  }

  const totalTokensBoughtRaw = sumTokensRaw.toString();
  const totalTokensBought = Number(ethers.formatUnits(sumTokensRaw, decimals));
  const totalMntPaidRaw = sumMntRaw.toString();
  const totalMntPaid = Number(ethers.formatUnits(sumMntRaw, 18));

  const weightedAveragePriceMNTPerToken =
    (sumTokensRaw > 0n && sumMntRaw > 0n)
      ? Number(ethers.formatUnits(sumMntRaw, 18)) / Number(ethers.formatUnits(sumTokensRaw, decimals))
      : null;

  const weightedFDV_MNT =
    weightedAveragePriceMNTPerToken != null ? weightedAveragePriceMNTPerToken * SUPPLY : null;

  // ===== Precio actual (preferencia: reservas del pool) =====
  let currentPriceMNTPerToken = null;
  let currentPriceSource = null;

  if (PRICE_MODE === 'tx_hash' && CURRENT_PRICE_TX) {
    const r = await getCurrentPrice_fromTxHash(CURRENT_PRICE_TX, TOKEN_ADDR, decimals);
    currentPriceMNTPerToken = r.priceMNTPerToken;
    currentPriceSource = r.source;
  } else {
    // intento por reservas primero
    const spot = await getCurrentPrice_fromReserves(TOKEN_ADDR, decimals);
    currentPriceMNTPerToken = spot.priceMNTPerToken;
    currentPriceSource = spot.source;

    // si no hubo pool o no se pudo leer, fallback
    if (currentPriceMNTPerToken == null) {
      const netLast = await getCurrentPrice_networkLastBuy(TOKEN_ADDR, decimals, LOOKBACK);
      currentPriceMNTPerToken = netLast.priceMNTPerToken;
      currentPriceSource = netLast.source;
    }
  }

  const currentFDV_MNT = currentPriceMNTPerToken != null ? currentPriceMNTPerToken * SUPPLY : null;

  // ===== PNL no realizado (sobre el balance actual) — reuso walletBal (no redeclarar)
  let pnlMNT = null;
  let pnlPct = null;
  if (currentPriceMNTPerToken != null && weightedAveragePriceMNTPerToken != null) {
    pnlMNT = walletBal * (currentPriceMNTPerToken - weightedAveragePriceMNTPerToken);
    pnlPct = ((currentPriceMNTPerToken / weightedAveragePriceMNTPerToken) - 1) * 100;
  }

  // ===== USD
  const weightedAveragePriceUSDPerToken =
    MNT_USD != null && weightedAveragePriceMNTPerToken != null
      ? weightedAveragePriceMNTPerToken * MNT_USD
      : null;

  const weightedFDV_USD =
    MNT_USD != null && weightedFDV_MNT != null ? weightedFDV_MNT * MNT_USD : null;

  const currentFDV_USD =
    MNT_USD != null && currentFDV_MNT != null ? currentFDV_MNT * MNT_USD : null;

  const pnlUSD = MNT_USD != null && pnlMNT != null ? pnlMNT * MNT_USD : null;

  const summary = {
    buysDetected,
    transfersNoPrice,
    totalTokensBoughtRaw,
    totalTokensBought,
    totalMntPaidRaw,
    totalMntPaid,
    weightedAveragePrice_MNT_per_Token: weightedAveragePriceMNTPerToken,
    weightedAveragePrice_USD_per_Token: weightedAveragePriceUSDPerToken,
    weightedFDV_MNT,
    weightedFDV_USD,
    weightedCircMcap_MNT: null,
    weightedCircMcap_USD: null,
    currentPrice_MNT_per_Token: currentPriceMNTPerToken,
    currentFDV_MNT,
    currentFDV_USD,
    currentPrice_source: currentPriceSource,
    walletBalanceTokens: walletBal,
    pnl_MNT: pnlMNT,
    pnl_USD: pnlUSD,
    pnl_percent: pnlPct
  };

  // Persistir full
  try {
    fs.writeFileSync(
      'entry_price_full.json',
      JSON.stringify({ wallet: WALLET_ADDR, token: { address: TOKEN_ADDR, symbol, decimals }, entries, summary }, null, 2)
    );
  } catch (e) {
    console.error('No se pudo guardar entry_price_full.json:', e?.message || e);
  }

  // Output y guardado
  const fullOut = {
    buysDetected: summary.buysDetected,
    transfersNoPrice: summary.transfersNoPrice,
    totalTokensBoughtRaw: summary.totalTokensBoughtRaw,
    totalTokensBought: summary.totalTokensBought,
    totalMntPaidRaw: summary.totalMntPaidRaw,
    totalMntPaid: summary.totalMntPaid,
    weightedAveragePrice_MNT_per_Token: summary.weightedAveragePrice_MNT_per_Token,
    weightedAveragePrice_USD_per_Token: summary.weightedAveragePrice_USD_per_Token,
    weightedFDV_MNT: summary.weightedFDV_MNT,
    weightedFDV_USD: summary.weightedFDV_USD,
    weightedCircMcap_MNT: summary.weightedCircMcap_MNT,
    weightedCircMcap_USD: summary.weightedCircMcap_USD,
    currentPrice_MNT_per_Token: summary.currentPrice_MNT_per_Token,
    currentFDV_MNT: summary.currentFDV_MNT,
    currentFDV_USD: summary.currentFDV_USD,
    currentPrice_source: summary.currentPrice_source,
    walletBalanceTokens: summary.walletBalanceTokens,
    pnl_MNT: summary.pnl_MNT,
    pnl_USD: summary.pnl_USD,
    pnl_percent: summary.pnl_percent
  };

  printPretty(fullOut);
  saveResults(fullOut);
}

main().catch((err) => {
  console.error('Error general:', err);
  process.exit(1);
});
