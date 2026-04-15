"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { hardhat } from "viem/chains";
import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";
import { FaucetButton, RainbowKitCustomConnectButton } from "~~/components/scaffold-eth";
import { useOutsideClick, useTargetNetwork } from "~~/hooks/scaffold-eth";

type HeaderMenuLink = { label: string; href: string; external?: boolean };

export const menuLinks: HeaderMenuLink[] = [
  { label: "Home", href: "https://turbousd.com", external: true },
  { label: "Dashboard", href: "/" },
  { label: "AMI Overview", href: "https://turbousd.com/ami", external: true },
  { label: "Get \u20B8USD", href: "https://turbousd.com/buy", external: true },
];

function IconX() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.259 5.631L18.244 2.25Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
    </svg>
  );
}

function IconTelegram() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

function IconDexscreener() {
  return (
    <svg width="20" height="20" viewBox="0 0 252 300" fill="currentColor">
      <path d="M151.818 106.866c9.177-4.576 20.854-11.312 32.545-20.541 2.465 5.119 2.735 9.586 1.465 13.193-.9 2.542-2.596 4.753-4.826 6.512-2.415 1.901-5.431 3.285-8.765 4.033-6.326 1.425-13.712.593-20.419-3.197m1.591 46.886l12.148 7.017c-24.804 13.902-31.547 39.716-39.557 64.859-8.009-25.143-14.753-50.957-39.556-64.859l12.148-7.017a5.95 5.95 0 003.84-5.845c-1.113-23.547 5.245-33.96 13.821-40.498 3.076-2.342 6.434-3.518 9.747-3.518s6.671 1.176 9.748 3.518c8.576 6.538 14.934 16.951 13.821 40.498a5.95 5.95 0 003.84 5.845zM126 0c14.042.377 28.119 3.103 40.336 8.406 8.46 3.677 16.354 8.534 23.502 14.342 3.228 2.622 5.886 5.155 8.814 8.071 7.897.273 19.438-8.5 24.796-16.709-9.221 30.23-51.299 65.929-80.43 79.589-.012-.005-.02-.012-.029-.018-5.228-3.992-11.108-5.988-16.989-5.988s-11.76 1.996-16.988 5.988c-.009.005-.017.014-.029.018-29.132-13.66-71.209-49.359-80.43-79.589 5.357 8.209 16.898 16.982 24.795 16.709 2.929-2.915 5.587-5.449 8.814-8.071C69.31 16.94 77.204 12.083 85.664 8.406 97.882 3.103 111.959.377 126 0m-25.818 106.866c-9.176-4.576-20.854-11.312-32.544-20.541-2.465 5.119-2.735 9.586-1.466 13.193.901 2.542 2.597 4.753 4.826 6.512 2.416 1.901 5.432 3.285 8.766 4.033 6.326 1.425 13.711.593 20.418-3.197" />
      <path d="M197.167 75.016c6.436-6.495 12.107-13.684 16.667-20.099l2.316 4.359c7.456 14.917 11.33 29.774 11.33 46.494l-.016 26.532.14 13.754c.54 33.766 7.846 67.929 24.396 99.193l-34.627-27.922-24.501 39.759-25.74-24.231L126 299.604l-41.132-66.748-25.739 24.231-24.501-39.759L0 245.25c16.55-31.264 23.856-65.427 24.397-99.193l.14-13.754-.016-26.532c0-16.721 3.873-31.578 11.331-46.494l2.315-4.359c4.56 6.415 10.23 13.603 16.667 20.099l-2.01 4.175c-3.905 8.109-5.198 17.176-2.156 25.799 1.961 5.554 5.54 10.317 10.154 13.953 4.48 3.531 9.782 5.911 15.333 7.161 3.616.814 7.3 1.149 10.96 1.035-.854 4.841-1.227 9.862-1.251 14.978L53.2 160.984l25.206 14.129a41.926 41.926 0 015.734 3.869c20.781 18.658 33.275 73.855 41.861 100.816 8.587-26.961 21.08-82.158 41.862-100.816a41.865 41.865 0 015.734-3.869l25.206-14.129-32.665-18.866c-.024-5.116-.397-10.137-1.251-14.978 3.66.114 7.344-.221 10.96-1.035 5.551-1.25 10.854-3.63 15.333-7.161 4.613-3.636 8.193-8.399 10.153-13.953 3.043-8.623 1.749-17.689-2.155-25.799l-2.01-4.175z" />
    </svg>
  );
}

function IconUniswap() {
  return (
    <svg width="20" height="20" viewBox="0 0 1440 1440" fill="currentColor">
      <g transform="matrix(.1 0 0 -.1 0 1440)">
        <path d="m882 14018c337-430 1016-1213 1488-1718 610-652 1135-1162 1880-1826 173-155 338-306 366-336 108-114 137-234 82-329-57-98-172-174-348-233-195-65-362-81-454-42-110 46-247 229-511 686-116 200-1153 1795-1162 1786-9-8 28-74 767-1390 180-320 272-495 291-550 52-155 58-277 18-401-12-38-23-90-26-115-5-68-54-157-139-256-187-217-255-340-329-595-43-148-65-265-109-570-49-340-100-538-198-769-153-362-355-669-838-1275-364-457-402-512-504-726-108-225-130-327-152-689-23-394 110-891 349-1305 22-38 97-160 167-270 215-338 320-545 320-629 0-74 30-76 281-21 833 185 1472 509 1803 913 148 181 185 309 181 617-2 158-16 220-71 326-91 173-239 313-594 560-348 241-519 417-625 641-70 148-89 242-89 433 0 140 3 172 26 255 36 132 101 293 235 580 276 588 331 779 378 1315 39 436 77 562 210 690 95 91 188 125 455 165 467 69 744 190 975 425 175 177 235 333 250 645l6 135-99 110c-156 175-529 520-1267 1176-1045 928-3012 2629-3040 2629-4 0 8-19 27-42z" />
        <path d="m4695 13113c-16-3-34-8-38-13-11-10 8-14 165-39 332-54 600-140 882-284 494-252 919-646 1486-1377 316-407 399-512 535-675 537-644 870-893 1445-1084 317-104 649-170 1040-206 36-3 85-8 110-10 83-8 304-23 445-30 694-37 1020-92 1267-216 235-118 385-253 550-498 39-58 75-110 80-116 22-25-32 271-78 424-112 369-357 817-639 1171-104 130-197 232-205 223-3-4-19-64-34-133-105-475-318-801-526-804-112-2-207 70-246 186-22 69-15 109 44 236 93 197 116 312 115 567 0 178-18 343-54 497-25 105-28 108-228 228-604 360-1264 565-1986 618-198 14-773 6-872-12-10-2-49-7-88-11-38-4-140-18-225-31s-168-26-185-29c-27-4-37 3-105 82-123 142-406 428-540 546-346 304-696 518-1051 642-192 67-327 96-644 140-54 7-383 14-420 8z" />
        <path d="m11352 12779c-108-225-158-444-177-764-16-287-30-331-97-318-18 3-89 26-158 51-322 115-449 157-624 208-104 30-210 57-235 60l-46 5 80-40c44-22 177-87 295-144 506-247 732-417 834-629 48-101 81-229 95-368 14-149 19-462 10-670-6-123-11-157-34-220-49-137-56-162-42-158 6 2 35 49 62 105 110 220 158 434 170 763 12 341 16 363 57 408 26 27 47 28 99 2 87-45 511-380 689-545 144-133 147-135 75-40-151 197-305 371-595 670-362 372-412 453-459 738-60 360-54 615 20 850 16 54 28 104 26 110-2 7-22-26-45-74z" />
        <path d="m4619 12698c0-18-2-42-5-53-2-11-7-96-10-190-21-573 204-1278 559-1754 329-440 876-761 1172-686 55 14 75 35 75 78 0 35-3 42-105 202-94 148-198 337-243 440-38 86-68 190-117 400-131 565-175 719-256 892-81 176-218 341-364 440-161 109-458 224-662 258l-43 7z" />
        <path d="m8439 9438c-4-309 10-464 57-645 166-639 720-1118 1879-1623 66-29 275-115 465-192 1167-474 1597-703 1921-1027 218-219 346-457 394-735 8-49 15-107 15-130 0-48 17-116 29-116 35 0 202 360 265 570 57 193 84 430 84 755 0 252-6 323-44 495-192 872-815 1508-1799 1836-342 114-622 172-1367 284-1024 153-1372 260-1729 529-81 61-152 111-158 111-7 0-11-37-12-112z" />
        <path d="m5625 8849c-124-12-229-64-338-167-168-160-245-344-235-561 8-150 29-220 89-286 79-86 169-113 374-113 341 1 658 104 824 266 75 74 104 136 109 228 8 146-55 282-198 425-107 107-190 158-306 185-90 21-231 31-319 23z" />
        <path d="m9420 7216c0-4 13-47 29-95 33-99 84-327 100-451 89-667-227-1237-846-1526-218-103-408-149-1083-264-761-130-1023-207-1415-418-139-74-285-167-285-181 0-12 19-7 169 41 299 95 691 166 1061 193 47 3 105 8 130 10 42 4 108 8 338 20 150 9 343 22 427 31 455 46 815 158 1098 343 171 112 358 296 469 463 104 156 202 402 213 538 10 114 12 342 4 461-17 245-171 579-368 799-22 25-41 41-41 36z" />
        <path d="m10185 6800c-20-39-62-215-74-310-11-95-12-333 0-425 32-254 116-520 250-786 84-169 212-374 569-914 379-573 485-745 611-990 164-320 244-598 252-876 8-273-40-489-174-787-70-155-79-182-56-182 20 0 265 137 367 205 409 273 729 674 918 1151 89 224 143 431 157 599 4 44 9 91 11 105 10 50 12 508 3 588-22 212-111 507-214 717-110 225-232 391-432 586-290 284-582 480-1291 865-396 216-608 335-736 416-60 37-117 68-127 68s-25-13-34-30z" />
        <path d="m6407 3814c-1-1-43-4-92-5-119-3-213-14-370-45-584-116-1240-417-1768-812-190-142-420-334-410-342 4-4 113-24 242-44 596-97 857-197 1176-453 61-48 239-215 396-369 157-155 324-310 370-344 192-144 433-218 674-207 104 4 136 10 223 39 137 47 201 87 308 193 78 77 98 103 137 185 58 118 76 214 72 365-5 198-51 310-169 423-122 115-253 170-426 179-113 6-195-9-274-49-134-67-226-206-228-343-2-136 66-236 191-280 71-25 80-17 18 18-73 41-123 89-138 134-19 59-7 183 23 234 84 143 269 207 452 158 60-16 165-72 223-118 76-60 123-159 130-275 11-170-35-296-151-412-118-118-233-161-401-151-222 13-483 168-589 350-137 233-101 537 86 742 154 168 362 247 628 240 239-6 429-71 640-220 293-207 445-429 730-1065 128-286 249-518 328-630 147-208 386-414 570-490 153-64 249-83 432-84 99 0 195 5 240 13 182 33 407 131 617 271 119 78 141 96 130 107-3 2-86-22-184-55-260-88-402-113-618-107-376 9-607 150-764 462-95 190-112 259-202 787-98 580-151 782-267 1011-175 348-409 574-787 760-273 134-529 200-860 220-117 7-334 13-338 9z" />
      </g>
    </svg>
  );
}

/* ── AMI Eye Icon ─────────────────────────────────────────────────────────── */
function AmiIcon({ size = 34 }: { size?: number }) {
  const iconRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [tipPos, setTipPos] = useState<{ top: number; left: number } | null>(null);
  const cleanupRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const smoothToggle = useCallback((activate: boolean) => {
    const icon = iconRef.current;
    if (!icon) return;
    const all = icon.querySelectorAll<SVGElement>(
      ".ami-eye-glow,.ami-eye-core,.ami-eye-center-glow,.ami-eye-glow-boost,.ami-eye-core-boost,.ami-eye-fill-boost,.ami-eye-center-boost",
    );
    const boosts = icon.querySelectorAll<SVGElement>(
      ".ami-eye-glow-boost,.ami-eye-core-boost,.ami-eye-fill-boost,.ami-eye-center-boost",
    );
    // Freeze at current opacity
    all.forEach(el => { el.style.opacity = getComputedStyle(el).opacity; el.style.transition = "none"; });
    boosts.forEach(el => { el.style.animation = "none"; });
    // Flip class while frozen
    if (activate) icon.classList.add("is-active");
    else icon.classList.remove("is-active");
    // Reflow
    void icon.offsetWidth;
    // Enable transition
    all.forEach(el => { el.style.transition = "opacity 800ms ease-in-out"; el.style.opacity = ""; });
    // Cleanup after transition
    if (cleanupRef.current) clearTimeout(cleanupRef.current);
    cleanupRef.current = setTimeout(() => {
      all.forEach(el => { el.style.transition = ""; });
      boosts.forEach(el => { el.style.animation = ""; });
    }, 850);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const next = !active;
    setActive(next);
    smoothToggle(next);
    if (next && iconRef.current) {
      const rect = iconRef.current.getBoundingClientRect();
      const tipW = 220;
      let left = rect.left + rect.width / 2 - tipW / 2;
      if (left < 8) left = 8;
      if (left + tipW > window.innerWidth - 8) left = window.innerWidth - 8 - tipW;
      setTipPos({ top: rect.bottom + window.scrollY + 8, left });
    }
  }, [active, smoothToggle]);

  // Close on outside click
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (iconRef.current?.contains(e.target as Node)) return;
      if (tipRef.current?.contains(e.target as Node)) return;
      setActive(false);
      smoothToggle(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [active, smoothToggle]);

  const svgHeight = size;

  return (
    <>
      <div
        ref={iconRef}
        role="button"
        tabIndex={0}
        aria-label="AMI (Artificial Monetary Intelligence)"
        className="ami-mini-icon"
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", height: svgHeight, lineHeight: 0 }}
        onClick={handleClick}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleClick(e as unknown as React.MouseEvent); } }}
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 136 286" style={{ height: svgHeight, width: "auto", display: "block" }}>
          <defs>
            <linearGradient id="frameGradH" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#f7f7f7"/><stop offset="18%" stopColor="#cfcfcf"/><stop offset="35%" stopColor="#8e8e8e"/>
              <stop offset="50%" stopColor="#ececec"/><stop offset="68%" stopColor="#8a8a8a"/><stop offset="85%" stopColor="#d7d7d7"/><stop offset="100%" stopColor="#ffffff"/>
            </linearGradient>
            <linearGradient id="innerFrameGradH" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0d1c10"/><stop offset="100%" stopColor="#051108"/>
            </linearGradient>
            <radialGradient id="panelGlowH" cx="50%" cy="55%" r="75%">
              <stop offset="0%" stopColor="#0f2a15"/><stop offset="55%" stopColor="#08210e"/><stop offset="100%" stopColor="#021006"/>
            </radialGradient>
            <radialGradient id="lensCoreH" cx="50%" cy="52%" r="52%">
              <stop offset="0%" stopColor="#dfff2c"/><stop offset="18%" stopColor="#9cff1f"/><stop offset="38%" stopColor="#24ff2f"/>
              <stop offset="62%" stopColor="#00d31b"/><stop offset="82%" stopColor="#006e0b"/><stop offset="100%" stopColor="#045108"/>
            </radialGradient>
            <radialGradient id="lensOuterGlowH" cx="50%" cy="52%" r="60%">
              <stop offset="0%" stopColor="#d8ff42" stopOpacity="0.95"/><stop offset="28%" stopColor="#67ff29" stopOpacity="0.9"/>
              <stop offset="58%" stopColor="#18e11d" stopOpacity="0.15"/><stop offset="100%" stopColor="#000000" stopOpacity="0"/>
            </radialGradient>
            <radialGradient id="ringMetalH" cx="35%" cy="30%" r="90%">
              <stop offset="0%" stopColor="#ffffff"/><stop offset="18%" stopColor="#d7d7d7"/><stop offset="38%" stopColor="#8d8d8d"/>
              <stop offset="55%" stopColor="#fafafa"/><stop offset="72%" stopColor="#727272"/><stop offset="88%" stopColor="#d0d0d0"/><stop offset="100%" stopColor="#000000"/>
            </radialGradient>
            <radialGradient id="ringShadowH" cx="50%" cy="50%" r="65%">
              <stop offset="65%" stopColor="#000000" stopOpacity="0"/><stop offset="100%" stopColor="#000000" stopOpacity="0.55"/>
            </radialGradient>
            <filter id="softGlowH" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="10" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <filter id="smallGlowH" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
          </defs>
          <rect x="3" y="3" width="130" height="280" rx="10" fill="url(#frameGradH)"/>
          <rect x="13" y="13" width="110" height="260" rx="6" fill="url(#innerFrameGradH)"/>
          <rect x="13" y="13" width="110" height="260" rx="6" fill="url(#panelGlowH)"/>
          <text x="68" y="42" fill="#ffffff" fontSize="18" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" textAnchor="middle" letterSpacing="2">AMI</text>
          <ellipse cx="68" cy="183" rx="58" ry="58" fill="url(#ringShadowH)" opacity="0.7"/>
          <circle cx="68" cy="180" r="52" fill="url(#ringMetalH)"/>
          <circle cx="68" cy="180" r="43" fill="#000000"/>
          <circle cx="68" cy="180" r="39" fill="#0c1a0d"/>
          <circle className="ami-eye-glow" cx="68" cy="180" r="34" fill="url(#lensOuterGlowH)" filter="url(#softGlowH)"/>
          <circle className="ami-eye-glow-boost" cx="68" cy="180" r="48" fill="url(#lensOuterGlowH)" filter="url(#softGlowH)"/>
          <circle className="ami-eye-core" cx="68" cy="180" r="24" fill="url(#lensCoreH)"/>
          <circle className="ami-eye-core-boost" cx="68" cy="180" r="36" fill="#6dff45"/>
          <circle className="ami-eye-fill-boost" cx="68" cy="180" r="31" fill="#9dff58"/>
          <circle className="ami-eye-center-glow" cx="68" cy="180" r="7" fill="#dfff35" filter="url(#smallGlowH)"/>
          <circle className="ami-eye-center-boost" cx="68" cy="180" r="18" fill="#f0ff96"/>
          <circle cx="68" cy="180" r="3" fill="#f5ff9d"/>
          <circle cx="68" cy="180" r="51" fill="none" stroke="#ffffff" strokeWidth="2" opacity="0.45"/>
          <circle cx="68" cy="180" r="38" fill="none" stroke="#72ff54" strokeWidth="1.5" opacity="0.35"/>
        </svg>
      </div>
      {/* Tooltip */}
      {active && tipPos && (
        <div
          ref={tipRef}
          className="fixed rounded-[10px] z-[99999] shadow-xl"
          style={{
            background: "#111",
            border: "1px solid #0f5a2a",
            padding: "12px 16px",
            minWidth: 200,
            top: tipPos.top,
            left: tipPos.left,
            animation: "amiFadeIn 180ms ease",
          }}
        >
          <span className="block mb-1.5 text-[13px] font-semibold text-white pl-[1.15em]">AMI 9000</span>
          {[
            { label: "What it does?", href: "https://turbousd.com/ami" },
            { label: "Managed funds", href: "https://treasury.turbousd.com" },
            { label: "Talk to AMI", href: "https://t.me/Turbo_USD" },
          ].map(link => (
            <span key={link.href} className="block mb-1 text-[13px]" style={{ whiteSpace: "nowrap" }}>
              <span className="text-[#ccc]">{"\u2192 "}</span>
              <a href={link.href} target="_blank" rel="noopener noreferrer" className="text-[#bdbdbd] no-underline hover:text-[#43e397] transition-colors">
                {link.label}
              </a>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/* ── AMI CSS (injected once) ──────────────────────────────────────────────── */
function AmiStyles() {
  return (
    <style jsx global>{`
      .ami-mini-icon { transition: transform 0.22s ease; }
      .ami-mini-icon .ami-eye-glow,
      .ami-mini-icon .ami-eye-core,
      .ami-mini-icon .ami-eye-center-glow { transition: opacity 0.8s ease-in-out; }
      .ami-mini-icon .ami-eye-glow   { opacity: 0.55; }
      .ami-mini-icon .ami-eye-core   { opacity: 0.7; }
      .ami-mini-icon .ami-eye-center-glow { opacity: 0.75; }
      .ami-mini-icon .ami-eye-glow-boost,
      .ami-mini-icon .ami-eye-core-boost,
      .ami-mini-icon .ami-eye-fill-boost,
      .ami-mini-icon .ami-eye-center-boost {
        opacity: 0; transition: opacity 0.8s ease-in-out; will-change: opacity;
      }
      /* pulse animation (only when NOT active) */
      .ami-mini-icon:not(.is-active) .ami-eye-glow-boost  { animation: amiGlowPulse 20s infinite ease-in-out; }
      .ami-mini-icon:not(.is-active) .ami-eye-core-boost  { animation: amiCorePulse 20s infinite ease-in-out; }
      .ami-mini-icon:not(.is-active) .ami-eye-fill-boost  { animation: amiFillPulse 20s infinite ease-in-out; }
      .ami-mini-icon:not(.is-active) .ami-eye-center-boost { animation: amiCenterPulse 20s infinite ease-in-out; }
      @keyframes amiGlowPulse   { 0%,16%,100%{opacity:0} 18%{opacity:0.18} 20%{opacity:1} 24%{opacity:1} 28%{opacity:0} }
      @keyframes amiCorePulse   { 0%,16%,100%{opacity:0} 18%{opacity:0.18} 20%{opacity:0.58} 24%{opacity:0.58} 28%{opacity:0} }
      @keyframes amiFillPulse   { 0%,16%,100%{opacity:0} 18%{opacity:0.18} 20%{opacity:0.52} 24%{opacity:0.52} 28%{opacity:0} }
      @keyframes amiCenterPulse { 0%,16%,100%{opacity:0} 18%{opacity:0.2} 20%{opacity:1} 24%{opacity:1} 28%{opacity:0} }
      /* hover */
      .ami-mini-icon:hover .ami-eye-glow          { opacity: 0.75; }
      .ami-mini-icon:hover .ami-eye-core           { opacity: 0.88; }
      .ami-mini-icon:hover .ami-eye-center-glow    { opacity: 0.92; }
      /* active (clicked, stays lit) */
      .ami-mini-icon.is-active .ami-eye-glow          { opacity: 1; }
      .ami-mini-icon.is-active .ami-eye-core           { opacity: 1; }
      .ami-mini-icon.is-active .ami-eye-center-glow    { opacity: 1; }
      .ami-mini-icon.is-active .ami-eye-glow-boost     { opacity: 1; }
      .ami-mini-icon.is-active .ami-eye-core-boost     { opacity: 0.68; }
      .ami-mini-icon.is-active .ami-eye-fill-boost     { opacity: 0.62; }
      .ami-mini-icon.is-active .ami-eye-center-boost   { opacity: 1; }
      .ami-mini-icon:focus-visible { outline: none; }
      @keyframes amiFadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }
    `}</style>
  );
}

const SOCIAL_LINKS = [
  { label: "X", href: "https://x.com/turbousd", icon: <IconX /> },
  { label: "Telegram", href: "https://t.me/turbousd", icon: <IconTelegram /> },
  { label: "Dexscreener", href: "https://dexscreener.com/base/0xd013725b904e76394a3ab0334da306c505d778f8", icon: <IconDexscreener /> },
  { label: "Uniswap", href: "https://app.uniswap.org/swap?outputCurrency=0x3d5e487B21E0569048c4D1A60E98C36e1B09DB07&chain=base", icon: <IconUniswap /> },
];

export const HeaderMenuLinks = () => {
  const pathname = usePathname();
  return (
    <>
      {menuLinks.map(({ label, href, external }) => {
        const isActive = !external && pathname === href;
        return (
          <li key={href}>
            {external ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="py-1.5 px-3 text-sm rounded-full gap-2 grid grid-flow-col hover:text-[#43e397] transition-colors text-[#888] hover:bg-transparent">
                <span>{label}</span>
              </a>
            ) : (
              <Link href={href} passHref className={`${isActive ? "text-[#43e397]" : "text-[#888]"} hover:text-[#43e397] transition-colors py-1.5 px-3 text-sm rounded-full gap-2 grid grid-flow-col hover:bg-transparent`}>
                <span>{label}</span>
              </Link>
            )}
          </li>
        );
      })}
    </>
  );
};

const MobileLinks = ({ onClose }: { onClose: () => void }) => {
  const pathname = usePathname();
  return (
    <div className="px-6 pb-4 space-y-0" style={{ paddingTop: 10 }}>
      {menuLinks.map(({ label, href, external }) => {
        const isActive = !external && pathname === href;
        return external ? (
          <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="block py-1 text-center text-[15px] font-medium text-white hover:text-[#43e397] transition-colors" onClick={onClose}>
            {label}
          </a>
        ) : (
          <Link key={href} href={href} className={`block py-1 text-center text-[15px] font-medium ${isActive ? "text-[#43e397]" : "text-white"} hover:text-[#43e397] transition-colors`} onClick={onClose}>
            {label}
          </Link>
        );
      })}
      <div className="flex items-center gap-5 pt-4 pb-4 justify-center">
        {SOCIAL_LINKS.map(({ label, href, icon }) => (
          <a key={label} href={href} target="_blank" rel="noopener noreferrer" aria-label={label} className="text-white hover:text-[#43e397] transition-colors">
            {icon}
          </a>
        ))}
      </div>
      <div className="flex justify-center pb-3">
        <a href="https://turbousd.com/buy" target="_blank" rel="noopener noreferrer" className="inline-block text-center py-2 px-10 text-sm font-semibold rounded-full transition-all duration-200 tusd-btn-outline" style={{ color: "#43e397", background: "transparent" }} onMouseEnter={e => { e.currentTarget.style.background = "#43e397"; e.currentTarget.style.color = "#000"; }} onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#43e397"; }} onClick={onClose}>
          {`Get \u20B8USD`}
        </a>
      </div>
    </div>
  );
};

export const Header = () => {
  const { targetNetwork } = useTargetNetwork();
  const isLocalNetwork = targetNetwork.id === hardhat.id;
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  useOutsideClick(mobileMenuRef, () => setMobileOpen(false));

  return (
    <div className="sticky top-0 z-20 w-full tusd-header" style={{ background: "#000000" }}>
      <AmiStyles />
      <div className="flex items-center justify-between h-14 px-6 max-w-7xl mx-auto">
        <div className="flex items-center gap-4">
          <Link href="/" passHref className="flex items-center gap-2 shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="https://turbousd.com/wp-content/uploads/2025/07/TurboUSD_t.png" alt={"\u20B8USD"} style={{ objectFit: "contain", height: "2.25rem", width: "auto" }} />
            <div className="flex flex-col leading-none">
              <span className="text-sm font-bold text-white tracking-tight">{"\u20B8USD Treasury"}</span>
              <span className="text-[10px] text-[#a6a6a6]">Operated by AMI</span>
            </div>
          </Link>
          <ul className="hidden lg:flex items-center gap-1">
            <HeaderMenuLinks />
          </ul>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {/* Desktop: social icons + AMI */}
          <div className="hidden lg:flex items-center gap-2">
            {SOCIAL_LINKS.map(({ label, href, icon }) => (
              <a key={label} href={href} target="_blank" rel="noopener noreferrer" aria-label={label} className="text-[#a6a6a6] hover:text-[#43e397] transition-colors p-1">
                {icon}
              </a>
            ))}
            <AmiIcon size={34} />
          </div>
          <RainbowKitCustomConnectButton />
          {isLocalNetwork && <FaucetButton />}
          {/* Mobile: AMI icon between Connect and burger */}
          <div className="lg:hidden">
            <AmiIcon size={26} />
          </div>
          <button className="lg:hidden btn btn-ghost btn-sm px-1" onClick={() => setMobileOpen(prev => !prev)}>
            {mobileOpen ? <XMarkIcon className="h-5 w-5 text-[#888]" /> : <Bars3Icon className="h-5 w-5 text-[#888]" />}
          </button>
        </div>
      </div>

      {/* Mobile menu — overlay, height collapse animation */}
      <div ref={mobileMenuRef} className="lg:hidden absolute left-0 right-0 overflow-hidden" style={{ background: "#000", top: "3.5rem", zIndex: 50, maxHeight: mobileOpen ? "400px" : "0px", transition: "max-height 0.3s ease", boxShadow: mobileOpen ? "0 8px 24px rgba(0,0,0,0.6)" : "none" }}>
        <MobileLinks onClose={() => setMobileOpen(false)} />
      </div>
    </div>
  );
};
