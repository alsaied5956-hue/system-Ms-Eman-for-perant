import React, { useState, useEffect } from "react";
import { Share, PlusSquare, X, BellRing, Smartphone, Check } from "lucide-react";

interface IOSPwaInstallBannerProps {
  onDismiss?: () => void;
}

export const IOSPwaInstallBanner: React.FC<IOSPwaInstallBannerProps> = ({ onDismiss }) => {
  const [showBanner, setShowBanner] = useState<boolean>(false);
  const [isDismissed, setIsDismissed] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") return;

    // 1. Check if device is iOS (iPhone, iPad, iPod)
    const ua = navigator.userAgent || "";
    const isIOSDevice =
      /iphone|ipad|ipod/i.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

    if (!isIOSDevice) return;

    // 2. Check if already running as installed Standalone PWA
    const isStandalone =
      (window.navigator as any).standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;

    if (isStandalone) return;

    // 3. Check if user already dismissed the prompt recently (e.g. within 5 days)
    try {
      const dismissedAt = localStorage.getItem("eman_ios_pwa_banner_dismissed_at");
      if (dismissedAt) {
        const diffMs = Date.now() - parseInt(dismissedAt, 10);
        if (diffMs < 5 * 24 * 60 * 60 * 1000) {
          return;
        }
      }
    } catch {}

    // Show banner after a gentle 1.5s delay to avoid layout shift during page load
    const timer = setTimeout(() => {
      setShowBanner(true);
    }, 1500);

    return () => clearTimeout(timer);
  }, []);

  const handleDismiss = () => {
    setIsDismissed(true);
    setShowBanner(false);
    try {
      localStorage.setItem("eman_ios_pwa_banner_dismissed_at", Date.now().toString());
    } catch {}
    onDismiss?.();
  };

  if (!showBanner || isDismissed) return null;

  return (
    <aside
      id="ios-pwa-install-banner"
      aria-label="تعليمات تثبيت المنظومة على أجهزة آيفون"
      dir="rtl"
      className="fixed bottom-4 inset-x-3 sm:inset-x-auto sm:right-6 sm:max-w-md z-[999999] animate-fadeIn"
    >
      <div className="relative overflow-hidden rounded-3xl bg-slate-900/95 backdrop-blur-xl border-2 border-emerald-500/40 p-5 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.85)] text-white">
        {/* Glow Accent */}
        <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 rounded-full blur-2xl pointer-events-none -mr-10 -mt-10" />

        {/* Close Button */}
        <button
          id="btn-close-ios-pwa-banner"
          type="button"
          onClick={handleDismiss}
          className="absolute top-3.5 left-3.5 p-1.5 rounded-full text-slate-400 hover:text-white hover:bg-slate-800 transition"
          title="إغلاق التنبيه"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Header */}
        <div className="flex items-start gap-3 mb-3 pl-6">
          <div className="w-10 h-10 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center shrink-0 text-emerald-400">
            <BellRing className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h4 className="font-bold text-sm text-emerald-300">
              تفعيل إشعارات الحضور والواجبات على الآيفون
            </h4>
            <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
              تتطلب حماية Apple إضافة المنظومة للشاشة الرئيسية لتصلك رنات التنبيه الفورية في الخلفية.
            </p>
          </div>
        </div>

        {/* Step-by-Step iOS Guide */}
        <div className="bg-slate-800/80 rounded-2xl p-3 border border-slate-700/60 space-y-2 mb-3.5 text-xs text-slate-200">
          <div className="flex items-center gap-2.5">
            <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[11px] shrink-0">
              1
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span>اضغط على زر المشاركة</span>
              <span className="inline-flex items-center gap-1 bg-slate-700/80 px-2 py-0.5 rounded-lg border border-slate-600 text-emerald-300 font-semibold text-[11px]">
                <Share className="w-3.5 h-3.5" />
                <span>Share</span>
              </span>
              <span>في شريط Safari السفلي.</span>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[11px] shrink-0">
              2
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span>مرر للأسفل واختر</span>
              <span className="inline-flex items-center gap-1 bg-slate-700/80 px-2 py-0.5 rounded-lg border border-slate-600 text-emerald-300 font-semibold text-[11px]">
                <PlusSquare className="w-3.5 h-3.5" />
                <span>إضافة إلى الصفحة الرئيسية</span>
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-[11px] shrink-0">
              3
            </span>
            <div className="flex items-center gap-1 text-slate-300">
              <span>افتح المنظومة من الشاشة الرئيسية واستمتع بالإشعارات كأي تطبيق أصلي.</span>
            </div>
          </div>
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            id="btn-confirm-ios-pwa-banner"
            type="button"
            onClick={handleDismiss}
            className="flex-1 py-2 px-3 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold text-xs transition shadow-md flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" />
            <span>حسناً، فهمت الخطوات</span>
          </button>
          <button
            id="btn-later-ios-pwa-banner"
            type="button"
            onClick={handleDismiss}
            className="py-2 px-3 rounded-xl text-slate-400 hover:text-slate-200 text-xs transition cursor-pointer"
          >
            لاحقاً
          </button>
        </div>
      </div>
    </aside>
  );
};
