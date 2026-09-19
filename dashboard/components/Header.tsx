"use client";

import Link from "next/link";
import { hardhat } from "viem/chains";
import { FaucetButton, RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { TusdHeader } from "~~/components/tusd-chrome";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";

/** This dashboard's own sections, shown in the bar under the turbousd.com menu. */
const TABS = [
  { label: "Dashboard", href: "/", active: true },
  { label: "Balances", href: "/#balances" },
  { label: "Activity", href: "/#activity" },
  { label: "Charts", href: "/#charts" },
  { label: "Burn Engine", href: "/#burn-engine" },
  { label: "Contracts", href: "/#contracts" },
];

/**
 * The same header as turbousd.com (menu, live ticker, AMI eye and treasury donut, Get ₸USD), with this
 * site's wallet button next to Get ₸USD and the dashboard's sections in the bar underneath.
 */
export const Header = () => {
  const { targetNetwork } = useTargetNetwork();
  const isLocalNetwork = targetNetwork.id === hardhat.id;

  return (
    <TusdHeader
      site={{ label: "₸USD Treasury", href: "/" }}
      tabs={TABS}
      Link={Link}
      connect={
        <>
          <RainbowKitCustomConnectButton />
          {isLocalNetwork && <FaucetButton />}
        </>
      }
    />
  );
};
