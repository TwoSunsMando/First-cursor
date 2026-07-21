import { getAddress, isAddress, type Address, zeroAddress } from "viem";
import {
  uniswapV2FactoryAbi,
  uniswapV3FactoryAbi,
} from "./abis.js";
import { ADDRESSES } from "./addresses.js";
import type { RhPublicClient } from "./client.js";
import type { DexKind } from "../db/schema.js";
import {
  readV2WethLiquidityEth,
  readV3WethLiquidityEth,
} from "./pricing.js";

const V3_FEES = [10000, 3000, 500, 100] as const;

export interface ResolvedWethPool {
  dex: DexKind;
  pairOrPool: Address;
  fee: number | null;
  liquidityEth: number | null;
}

/**
 * Find the best WETH pool for a meme token (V2 pair or richest V3 fee tier).
 */
export async function resolveWethPool(
  client: RhPublicClient,
  token: Address,
): Promise<ResolvedWethPool | null> {
  const tokenAddr = getAddress(token);
  const weth = ADDRESSES.WETH;

  let best: ResolvedWethPool | null = null;

  try {
    const pair = await client.readContract({
      address: ADDRESSES.UNISWAP_V2_FACTORY,
      abi: uniswapV2FactoryAbi,
      functionName: "getPair",
      args: [tokenAddr, weth],
    });
    if (pair && pair.toLowerCase() !== zeroAddress) {
      const liq = await readV2WethLiquidityEth(client, pair);
      best = {
        dex: "v2",
        pairOrPool: getAddress(pair),
        fee: null,
        liquidityEth: liq,
      };
    }
  } catch {
    // ignore
  }

  for (const fee of V3_FEES) {
    try {
      const pool = await client.readContract({
        address: ADDRESSES.UNISWAP_V3_FACTORY,
        abi: uniswapV3FactoryAbi,
        functionName: "getPool",
        args: [tokenAddr, weth, fee],
      });
      if (!pool || pool.toLowerCase() === zeroAddress) continue;
      const liq = await readV3WethLiquidityEth(client, pool);
      if (
        !best ||
        (liq != null && (best.liquidityEth == null || liq > best.liquidityEth))
      ) {
        best = {
          dex: "v3",
          pairOrPool: getAddress(pool),
          fee,
          liquidityEth: liq,
        };
      }
    } catch {
      // next fee
    }
  }

  return best;
}

export function parseWalletList(raw: string): Address[] {
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const t = part.trim();
    if (!t || t.startsWith("#")) continue;
    if (!isAddress(t)) continue;
    const a = getAddress(t);
    const key = a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}
