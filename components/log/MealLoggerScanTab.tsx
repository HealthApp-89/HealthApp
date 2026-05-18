"use client";
import { useEffect, useRef, useState } from "react";
import { fmtNum } from "@/lib/ui/score";

type Product = {
  entry: {
    id: string;
    items: { name: string; qty_g: number; kcal: number; protein_g: number; carbs_g: number; fat_g: number }[];
    totals: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
  };
  product_image: string | null;
};

export function MealLoggerScanTab({ onCommitted }: { onCommitted: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [scanned, setScanned] = useState<Product | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const has = typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector !== "undefined";
    setSupported(has);
    if (!has) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        if (stopped) return;
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch {
        setError("Camera permission required");
      }
    })();
    const detector = new (window as unknown as { BarcodeDetector: new (opts: { formats: string[] }) => { detect: (s: HTMLVideoElement) => Promise<{ rawValue: string }[]> } }).BarcodeDetector({
      formats: ["ean_13", "upc_a", "upc_e", "ean_8"],
    });
    const tick = async () => {
      if (stopped || !videoRef.current || scanned) return;
      try {
        const codes = await detector.detect(videoRef.current);
        if (codes[0]?.rawValue) {
          await onDetected(codes[0].rawValue);
          return;
        }
      } catch {
        /* ignore — keep scanning */
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [scanned]);

  const onDetected = async (upc: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/food/barcode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ upc }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "scan_failed");
      setScanned(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!scanned) return;
    setBusy(true);
    try {
      const res = await fetch("/api/food/commit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entry_id: scanned.entry.id }),
      });
      if (!res.ok) throw new Error("commit_failed");
      setScanned(null);
      onCommitted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (supported === false) {
    return (
      <div className="text-sm text-zinc-400">
        Barcode scanning isn&apos;t supported in this browser. Use the Type tab instead.
      </div>
    );
  }

  if (scanned) {
    const item = scanned.entry.items[0];
    return (
      <div className="space-y-3">
        {scanned.product_image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={scanned.product_image} alt="" className="mx-auto h-32 w-32 rounded-md object-cover" />
        )}
        <div className="text-center">
          <div className="font-medium">{item.name}</div>
          <div className="text-xs text-zinc-400">
            {fmtNum(item.qty_g)} g · {fmtNum(item.kcal)} kcal · {fmtNum(item.protein_g)} P · {fmtNum(item.carbs_g)} C · {fmtNum(item.fat_g)} F
          </div>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={() => setScanned(null)} disabled={busy} className="flex-1 rounded-md border border-zinc-700 py-2 text-sm">
            Scan another
          </button>
          <button type="button" onClick={commit} disabled={busy} className="flex-1 rounded-md bg-zinc-100 py-2 text-sm text-zinc-900">
            {busy ? "..." : "Commit"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <video ref={videoRef} autoPlay playsInline className="w-full rounded-md bg-zinc-950" />
      <p className="text-center text-xs text-zinc-500">Point at a barcode</p>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
