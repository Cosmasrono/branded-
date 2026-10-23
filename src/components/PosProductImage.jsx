"use client";

import { useState } from "react";

const SAMPLE_IMAGES = {
  TEE: "tshirt",
  JUMP: "jumper",
  HOOD: "hoodie",
  CAP: "cap",
  MUG: "mug",
};

export default function PosProductImage({ product }) {
  const [failed, setFailed] = useState(false);
  const code = product.sku?.startsWith("DEMO-BRAND-")
    ? product.sku.slice("DEMO-BRAND-".length).split("-")[0]
    : null;
  const sample = SAMPLE_IMAGES[code];

  return (
    <div className="relative mb-3 aspect-square overflow-hidden rounded-lg bg-slate-50 border border-slate-100">
      {sample && !failed ? (
        <>
          {/* Local sample assets also work with the POS service worker cache. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/images/branding/${sample}.png`}
            alt={`Sample branded ${sample === "tshirt" ? "T-shirt" : sample}; actual colour and size are listed below`}
            width={512}
            height={512}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className="h-full w-full object-contain"
          />
          <span className="absolute bottom-2 left-2 rounded bg-white/95 px-2 py-0.5 text-[10px] font-medium text-slate-500 shadow-sm">Sample design</span>
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center text-slate-400">
          <span className="text-xs font-medium text-slate-500">{product.category || "Product"}</span>
          <span className="text-[10px]">No photo yet</span>
        </div>
      )}
    </div>
  );
}
