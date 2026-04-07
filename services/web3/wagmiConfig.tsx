import { wagmiConnectors } from "./wagmiConnectors";
import { Chain, createClient, fallback, http } from "viem";
import { hardhat, mainnet } from "viem/chains";
import { createConfig } from "wagmi";
import scaffoldConfig, { ScaffoldConfig } from "~~/scaffold.config";
import { getAlchemyHttpUrl } from "~~/utils/scaffold-eth";


const { targetNetworks } = scaffoldConfig;

// We always want to have mainnet enabled (ENS resolution, ETH price, etc). But only once.
export const enabledChains = targetNetworks.find((network: Chain) => network.id === 1)
  ? targetNetworks
  : ([...targetNetworks, mainnet] as const);

// User's own RPC endpoint as fallback (set NEXT_PUBLIC_RPC_FALLBACK_URL in env)
const FALLBACK_RPC_URL = process.env.NEXT_PUBLIC_RPC_FALLBACK_URL;

export const wagmiConfig = createConfig({
  chains: enabledChains,
  connectors: wagmiConnectors(),
  ssr: true,
  client: ({ chain }) => {
    // 1) SE-2 default Alchemy key goes FIRST (primary)
    const alchemyHttpUrl = getAlchemyHttpUrl(chain.id);
    const transports = alchemyHttpUrl ? [http(alchemyHttpUrl)] : [];

    // 2) User's own RPC as FALLBACK (only for Base, only if env var is set)
    if (FALLBACK_RPC_URL && chain.id === 8453) transports.push(http(FALLBACK_RPC_URL));

    // 3) Public RPC as last resort
    if (chain.id === mainnet.id) transports.push(http("https://mainnet.rpc.buidlguidl.com"));
    transports.push(http());

    // 4) rpcOverrides take top priority if set
    const rpcOverrideUrl = (scaffoldConfig.rpcOverrides as ScaffoldConfig["rpcOverrides"])?.[chain.id];
    if (rpcOverrideUrl) transports.unshift(http(rpcOverrideUrl));

    return createClient({
      chain,
      transport: fallback(transports),
      ...(chain.id !== (hardhat as Chain).id ? { pollingInterval: scaffoldConfig.pollingInterval } : {}),
    });
  },
});
