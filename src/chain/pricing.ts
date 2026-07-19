import {
  formatEther,
  parseEther,
  type Address,
} from "viem";
import {
  erc20Abi,
  quoterV2Abi,
  uniswapV2PairAbi,
  uniswapV2RouterAbi,
  uniswapV3PoolAbi,
} from "./abis.js";
import { ADDRESSES } from "./addresses.js";
import type { RhPublicClient } from "./client.js";
import type { DexKind } from "../db/schema.js";

export async function readTokenMeta(
  client: RhPublicClient,
  token: Address,
): Promise<{ name: string; symbol: string; decimals: number }> {
  try {
    const [name, symbol, decimals] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    ]);
    return { name, symbol, decimals };
  } catch {
    return { name: "Unknown", symbol: "???", decimals: 18 };
  }
}

/** ETH per 1 token (approximate mid), or null if unquoteable. */
export async function quoteTokenPriceEth(
  client: RhPublicClient,
  token: Address,
  dex: DexKind,
  pairOrPool: Address,
  fee: number | null,
  tokenDecimals = 18,
): Promise<number | null> {
  try {
    if (dex === "v2" || dex === "noxa") {
      // Prefer V2 router getAmountsOut for 1 token → WETH/ETH
      const one = 10n ** BigInt(tokenDecimals);
      try {
        const amounts = await client.readContract({
          address: ADDRESSES.UNISWAP_V2_ROUTER,
          abi: uniswapV2RouterAbi,
          functionName: "getAmountsOut",
          args: [one, [token, ADDRESSES.WETH]],
        });
        const out = amounts[amounts.length - 1];
        if (out > 0n) return Number(formatEther(out));
      } catch {
        // fall through to reserves
      }

      try {
        const [token0, reserves] = await Promise.all([
          client.readContract({
            address: pairOrPool,
            abi: uniswapV2PairAbi,
            functionName: "token0",
          }),
          client.readContract({
            address: pairOrPool,
            abi: uniswapV2PairAbi,
            functionName: "getReserves",
          }),
        ]);
        const [r0, r1] = reserves;
        const wethIs0 = token0.toLowerCase() === ADDRESSES.WETH.toLowerCase();
        const wethReserve = wethIs0 ? r0 : r1;
        const tokenReserve = wethIs0 ? r1 : r0;
        if (tokenReserve === 0n) return null;
        return Number(wethReserve) / Number(tokenReserve);
      } catch {
        return null;
      }
    }

    // V3 via QuoterV2 — sell 1 token for WETH
    const poolFee = fee ?? 10000;
    const one = 10n ** BigInt(tokenDecimals);
    const result = await client.simulateContract({
      address: ADDRESSES.QUOTER_V2,
      abi: quoterV2Abi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: token,
          tokenOut: ADDRESSES.WETH,
          amountIn: one,
          fee: poolFee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const amountOut = result.result[0];
    if (amountOut === 0n) return null;
    return Number(formatEther(amountOut));
  } catch {
    return null;
  }
}

const V3_QUOTE_FEES = [10000, 3000, 500, 100] as const;

function v3FeeAttempts(fee: number | null): number[] {
  const out: number[] = [];
  if (fee != null && Number.isFinite(fee)) out.push(Number(fee));
  for (const f of V3_QUOTE_FEES) {
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

/** How many tokens you get for `ethIn` ETH (approx). */
export async function quoteBuyTokensForEth(
  client: RhPublicClient,
  token: Address,
  dex: DexKind,
  fee: number | null,
  ethIn: number,
): Promise<bigint | null> {
  try {
    const amountIn = parseEther(ethIn.toFixed(18));
    if (dex === "v3") {
      for (const poolFee of v3FeeAttempts(fee)) {
        try {
          const result = await client.simulateContract({
            address: ADDRESSES.QUOTER_V2,
            abi: quoterV2Abi,
            functionName: "quoteExactInputSingle",
            args: [
              {
                tokenIn: ADDRESSES.WETH,
                tokenOut: token,
                amountIn,
                fee: poolFee,
                sqrtPriceLimitX96: 0n,
              },
            ],
          });
          if (result.result[0] > 0n) return result.result[0];
        } catch {
          /* try next fee */
        }
      }
      return null;
    }

    const amounts = await client.readContract({
      address: ADDRESSES.UNISWAP_V2_ROUTER,
      abi: uniswapV2RouterAbi,
      functionName: "getAmountsOut",
      args: [amountIn, [ADDRESSES.WETH, token]],
    });
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

/** How much WETH/ETH you get selling `tokenAmount` raw units (approx). */
export async function quoteSellEthForTokens(
  client: RhPublicClient,
  token: Address,
  dex: DexKind,
  fee: number | null,
  tokenAmount: bigint,
): Promise<bigint | null> {
  if (tokenAmount <= 0n) return null;
  try {
    if (dex === "v3") {
      for (const poolFee of v3FeeAttempts(fee)) {
        try {
          const result = await client.simulateContract({
            address: ADDRESSES.QUOTER_V2,
            abi: quoterV2Abi,
            functionName: "quoteExactInputSingle",
            args: [
              {
                tokenIn: token,
                tokenOut: ADDRESSES.WETH,
                amountIn: tokenAmount,
                fee: poolFee,
                sqrtPriceLimitX96: 0n,
              },
            ],
          });
          if (result.result[0] > 0n) return result.result[0];
        } catch {
          /* try next fee */
        }
      }
      return null;
    }

    const amounts = await client.readContract({
      address: ADDRESSES.UNISWAP_V2_ROUTER,
      abi: uniswapV2RouterAbi,
      functionName: "getAmountsOut",
      args: [tokenAmount, [token, ADDRESSES.WETH]],
    });
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

export async function readV2WethLiquidityEth(
  client: RhPublicClient,
  pair: Address,
): Promise<number | null> {
  try {
    const [token0, reserves] = await Promise.all([
      client.readContract({ address: pair, abi: uniswapV2PairAbi, functionName: "token0" }),
      client.readContract({ address: pair, abi: uniswapV2PairAbi, functionName: "getReserves" }),
    ]);
    const [r0, r1] = reserves;
    const wethIs0 = token0.toLowerCase() === ADDRESSES.WETH.toLowerCase();
    const wethReserve = wethIs0 ? r0 : r1;
    return Number(formatEther(wethReserve));
  } catch {
    return null;
  }
}

export async function readV3PoolFee(
  client: RhPublicClient,
  pool: Address,
): Promise<number | null> {
  try {
    return await client.readContract({
      address: pool,
      abi: uniswapV3PoolAbi,
      functionName: "fee",
    });
  } catch {
    return null;
  }
}

/** Approximate V3 pool WETH inventory via ERC-20 balanceOf(pool). */
export async function readV3WethLiquidityEth(
  client: RhPublicClient,
  pool: Address,
): Promise<number | null> {
  try {
    const bal = await client.readContract({
      address: ADDRESSES.WETH,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [pool],
    });
    return Number(formatEther(bal));
  } catch {
    return null;
  }
}

export function otherToken(token0: Address, token1: Address, weth: Address): Address | null {
  const w = weth.toLowerCase();
  if (token0.toLowerCase() === w) return token1;
  if (token1.toLowerCase() === w) return token0;
  return null;
}
