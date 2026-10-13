import React, { useState, useEffect } from "react";
import { usePWAInstall } from "../../hooks/usePWAInstall";
import { Share, PlusSquare, X, Smartphone } from "lucide-react";

export const IOSPwaInstallBanner: React.FC = () => {
  const { isIOS, isInstalled } = usePWAInstall();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const isDismissed = localStorage.getItem("eman_ios_pwa_banner_dismissed");
      if (!isDismissed && isIOS && !isInstalled) {
        setDismissed(false);
      }
    }
  }, [isIOS, isInstalled]);

  if (dismissed || !isIOS || isInstalled) {
    return null;
  }

  const handleDismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem("eman_ios_pwa_banner_dismissed", "true");
    } catch {}
  };

  return (
    <div
      id="ios-pwa-install-banner"
      dir="rtl"
      className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md rounded-2xl border border-amber-500/40 bg-slate-900/95 p-4 text-slate-100 shadow-2xl backdrop-blur-md animate-fadeIn"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/20 text-amber-400">
            <Smartphone className="h-5 w-5" />
          </div>
          <div>
            <h4 className="text-sm font-bold text-white font-fancy">
              تثبيت المنظومة على آيفون / آيباد
            </h4>
            <p className="text-xs text-amber-300 font-tajawal">
              للحصول على تجربة التطبيق الأصلي السريع
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition cursor-pointer"
          aria-label="إغلاق"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 space-y-2 text-xs text-slate-300 font-tajawal">
        <div className="flex items-center gap-2 rounded-xl bg-slate-800/70 p-2 border border-slate-700/50">
          <Share className="h-4 w-4 text-sky-400 shrink-0" />
          <span>
            1. اضغط على زر <strong>المشاركة (Share)</strong> أسفل متصفح Safari.
          </span>
        </div>
        <div className="flex items-center gap-2 rounded-xl bg-slate-800/70 p-2 border border-slate-700/50">
          <PlusSquare className="h-4 w-4 text-amber-400 shrink-0" />
          <span>
            2. اختر <strong>إضافة إلى الصفحة الرئيسية (Add to Home Screen)</strong>.
          </span>
        </div>
      </div>
    </div>
  );
};
