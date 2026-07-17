import { defineChain, type Address } from "viem";

/** Robinhood Chain mainnet — https://docs.robinhood.com/chain/connecting/ */
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});

/**
 * Known mainnet deployments. Re-verify on Blockscout before live trading.
 * Sources: Robinhood docs, Uniswap RH Chain deployments, NOXA sniper references.
 */
export const ADDRESSES = {
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address,
  UNISWAP_V2_FACTORY: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f" as Address,
  UNISWAP_V2_ROUTER: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba" as Address,
  UNISWAP_V3_FACTORY: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address,
  SWAP_ROUTER_02: "0xCaf681a66D020601342297493863E78C959E5cb2" as Address,
  QUOTER_V2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7" as Address,
  NOXA_LAUNCH_FACTORY: "0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB" as Address,
} as const;

export const EXPLORER_TX = (hash: string) =>
  `https://robinhoodchain.blockscout.com/tx/${hash}`;
