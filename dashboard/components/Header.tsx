"use client";

import Link from "next/link";
import { hardhat } from "viem/chains";
import { useAccount } from "wagmi";
import { FaucetButton, RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { TusdHeader } from "~~/components/tusd-chrome";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";

/**
 * The same header as turbousd.com (menu, live ticker, AMI eye and treasury donut, Get ₸USD), with the
 * connected wallet's menu next to Get ₸USD once a wallet is connected. No section bar: the dashboard is one page.
 */
export const Header = () => {
  const { targetNetwork } = useTargetNetwork();
  const isLocalNetwork = targetNetwork.id === hardhat.id;
  // No Connect button in the header: wallets connect where an action needs one (burn, checkout,
  // my orders). Once a wallet is connected, its address menu shows here so it can be switched or
  // disconnected.
  const { isConnected } = useAccount();

  return (
    <TusdHeader
      site={{ label: "₸USD Treasury", href: "/" }}
      Link={Link}
      connect={
        isConnected || isLocalNetwork ? (
          <>
            {isConnected && <RainbowKitCustomConnectButton />}
            {isLocalNetwork && <FaucetButton />}
          </>
        ) : undefined
      }
    />
  );
};
