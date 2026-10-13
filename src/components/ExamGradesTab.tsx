import React, { useState, useEffect, useMemo } from "react";
import { Student } from "../types";
import {
  openWhatsApp,
  SCHOOL_WHATSAPP_PHONE,
  sortStudentsByGradeAndName,
  STANDARD_EVALUATIONS,
  getStudentRecordedExams,
  getNextSuggestedEvaluation,
} from "../utils/helpers";
import { enqueuePlatformMessage } from "../utils/storage";
import { playBeep } from "../utils/audio";
import { dispatchPushNotification } from "../services/pushNotificationService";
import { StudentSearchBox } from "./StudentSearchBox";
import {
  FileCheck2,
  Send,
  Sparkles,
  CheckCircle2,
  Loader2,
  Trash2,
  AlertTriangle,
  ChevronDown,
  RotateCcw,
} from "lucide-react";

interface ExamGradesTabProps {
  students: Student[];
  onRecordGrade: (barcode: string, examTitle: string, score: number, maxScore: number) => void;
  onClearGrade?: (barcode: string) => void;
}

export const ExamGradesTab: React.FC<ExamGradesTabProps> = ({
  students,
  onRecordGrade,
  onClearGrade,
}) => {
  // Retain the exam title and maximum score across submissions and browser refreshes
  const [examTitle, setExamTitle] = useState<string>(() => {
    return localStorage.getItem("eman_last_exam_title") || STANDARD_EVALUATIONS[0];
  });
  const [maxScore, setMaxScore] = useState<number>(() => {
    const saved = localStorage.getItem("eman_last_max_score");
    return saved !== null && !isNaN(Number(saved)) && Number(saved) > 0 ? Number(saved) : 10;
  });

  const [searchInput, setSearchInput] = useState("");
  const [studentScore, setStudentScore] = useState<number | "">("");
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [lastRecordedInfo, setLastRecordedInfo] = useState<{
    studentName: string;
    barcode: string;
    grade: string;
    phone?: string;
    score: number;
    maxScore: number;
    percentage: number;
    examTitle: string;
    message?: string;
  } | null>(null);

  // Sync to local storage whenever title or max score changes
  const handleExamTitleChange = (val: string) => {
    setExamTitle(val);
    try {
      localStorage.setItem("eman_last_exam_title", val);
    } catch {
      // ignore
    }
  };

  const handleMaxScoreChange = (val: number) => {
    setMaxScore(val);
    try {
      localStorage.setItem("eman_last_max_score", String(val));
    } catch {
      // ignore
    }
  };

  // Evaluate which exams the currently selected student already completed
  const recordedExamsForSelected = useMemo(() => {
    if (!selectedStudent) return [];
    return getStudentRecordedExams(selectedStudent);
  }, [selectedStudent]);

  // Is current exam title already taken by selected student?
  const isCurrentExamDuplicate = useMemo(() => {
    if (!selectedStudent || !examTitle.trim()) return false;
    return recordedExamsForSelected.includes(examTitle.trim());
  }, [selectedStudent, examTitle, recordedExamsForSelected]);

  // Next sequential evaluation for selected student
  const nextSuggestedForSelected = useMemo(() => {
    if (!selectedStudent) return STANDARD_EVALUATIONS[0];
    return getNextSuggestedEvaluation(selectedStudent);
  }, [selectedStudent]);

  // Select student and automatically ensure examTitle is not a duplicate for them
  const handleSelectStudent = (student: Student) => {
    setSelectedStudent(student);
    setSearchInput(student.name);
    playBeep("success");

    // If current title is already recorded for this student, auto-advance to their next unrecorded evaluation!
    const studentRecorded = getStudentRecordedExams(student);
    if (studentRecorded.includes(examTitle.trim())) {
      const nextEval = getNextSuggestedEvaluation(student);
      setExamTitle(nextEval);
      try {
        localStorage.setItem("eman_last_exam_title", nextEval);
      } catch {}
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (!selectedStudent) {
      setFeedback({ type: "error", message: "⚠️ يرجى اختيار أو مسح باركود طالب مسجل أولاً!" });
      return;
    }

    const currentTitle = examTitle.trim() || STANDARD_EVALUATIONS[0];

    // STRICT ANTI-DUPLICATION RULE: An exam title can NEVER be repeated for the same student!
    if (isCurrentExamDuplicate) {
      setFeedback({
        type: "error",
        message: `⚠️ غير مسموح بتكرار الامتحان! (${currentTitle}) مسجل بالفعل للطالب (${selectedStudent.name}). التقييم يُرصد مرة واحدة فقط ولا يتكرر! التقييم التالي المقترح: (${nextSuggestedForSelected}).`,
      });
      playBeep("error");
      return;
    }

    const scoreNum = Number(studentScore);
    const maxNum = Number(maxScore);

    if (isNaN(scoreNum) || isNaN(maxNum) || maxNum <= 0) {
      setFeedback({ type: "error", message: "⚠️ يرجى إدخال درجات صحيحة ومقبولة!" });
      return;
    }

    if (scoreNum < 0) {
      setFeedback({ type: "error", message: "⚠️ لا يمكن أن تكون درجة الطالب أقل من الصفر!" });
      return;
    }

    if (scoreNum > maxNum) {
      setFeedback({ type: "error", message: `⚠️ لا يمكن أن تكون درجة الطالب (${scoreNum}) أكبر من الدرجة العظمى (${maxNum})!` });
      return;
    }

    setIsSubmitting(true);

    // 1. Record grade in system
    onRecordGrade(selectedStudent.barcode, currentTitle, scoreNum, maxNum);
    playBeep("success");

    const percentage = Math.round((scoreNum / maxNum) * 100);
    let evaluation = "ممتاز جداً 🌟 واصل التألق والتميز!";
    if (percentage < 60) {
      evaluation = "⚠️ تحذير عاجل: مستوى الطالب يحتاج متابعة ومذاكرة مضاعفة.";
    } else if (percentage < 80) {
      evaluation = "جيد 👍 ونتطلع للمزيد من الاجتهاد والتركيز.";
    }

    const msg = `نتيجة اختبار الرياضيات 📐\nالامتحان: (${currentTitle})\nاسم الطالب: ${selectedStudent.name}\nالصف: ${selectedStudent.groupGrade}\nالدرجة: ${scoreNum} من ${maxNum} (${percentage}%)\nالتقييم: ${evaluation}\nمع تحيات ميس إيمان الدمشيتي ✨`;

    // Direct Platform Notification sent to Firebase platform_messages & notifications collections
    enqueuePlatformMessage({
      studentBarcode: selectedStudent.barcode,
      studentName: selectedStudent.name,
      grade: selectedStudent.groupGrade,
      phone: selectedStudent.parentPhone,
      messageType: "درجات",
      title: `نتيجة تقييم الرياضيات - ${selectedStudent.name}`,
      message: msg,
      channel: "in_app",
    });

    // 🔔 Loud Native Background Web Push & FCM Notification to Parent Phone
    dispatchPushNotification({
      targetUserIds: [selectedStudent.barcode, selectedStudent.parentPhone || "", selectedStudent.phone || ""].filter(Boolean),
      title: `📊 نتيجة اختبار: ${currentTitle}`,
      body: `حصل الطالب (${selectedStudent.name}) على درجة ${scoreNum} من ${maxNum} (${percentage}%). ${evaluation}`,
      type: "grade",
      tag: `exam-${selectedStudent.barcode}-${Date.now()}`,
      eventId: `exam-${selectedStudent.barcode}-${currentTitle}-${Date.now()}`,
      url: "/?tab=exams",
      sound: "/notification.wav",
    }).catch(() => {});

    setFeedback({
      type: "success",
      message: `✅ تم رصد درجة (${selectedStudent.name}) بنجاح: ${currentTitle} [${scoreNum}/${maxNum} - ${percentage}%] ولم يتكرر أي تقييم!`,
    });

    // Save info for visual confirmation card
    setLastRecordedInfo({
      studentName: selectedStudent.name,
      barcode: selectedStudent.barcode,
      grade: selectedStudent.groupGrade,
      phone: selectedStudent.parentPhone,
      score: scoreNum,
      maxScore: maxNum,
      percentage,
      examTitle: currentTitle,
      message: msg,
    });

    // Reset student selection & score for next student
    setSearchInput("");
    setSelectedStudent(null);
    setStudentScore("");
    setIsSubmitting(false);

    setTimeout(() => {
      setFeedback(null);
    }, 4500);
  };

  const handleSendAllGradesToTeacher = () => {
    const sorted = sortStudentsByGradeAndName(students);
    let msg = `📋 كشف درجات آخر اختبار لطلاب ميس إيمان الدمشيتي:\n\n`;
    let count = 0;
    sorted.forEach((s) => {
      if (s.lastExamScore) {
        count++;
        msg += `• ${s.name} (${s.groupGrade}): ${s.lastExamScore}\n`;
      }
    });

    if (count === 0) {
      setFeedback({ type: "error", message: "⚠️ لا يوجد درجات مسجلة للطلاب بعد!" });
      return;
    }

    openWhatsApp(SCHOOL_WHATSAPP_PHONE, msg);
  };

  // Quick chips: Top standard evaluations
  const quickChips = STANDARD_EVALUATIONS.slice(0, 8);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="glass-panel p-6 md:p-8 rounded-3xl shadow-2xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3.5 pb-4 border-b border-indigo-500/20">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-400 flex items-center justify-center shadow-md">
              <FileCheck2 className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold font-fancy text-amber-300">
                رصد درجات الاختبارات المتسلسلة
              </h2>
              <p className="text-xs text-slate-400 font-tajawal mt-0.5">
                التقييم الأول، الثاني، الثالث، الرابع... مع قفل فوري يمنع تكرار أي تقييم لنفس الطالب
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleSendAllGradesToTeacher}
            className="px-4 py-2.5 rounded-2xl bg-gradient-to-r from-sky-500/20 to-cyan-500/10 hover:bg-sky-500/30 border border-sky-500/30 text-sky-300 text-xs font-bold transition-all shadow-md flex items-center gap-1.5 cursor-pointer font-tajawal"
          >
            <span>📲 إرسال الكشف لميس إيمان</span>
          </button>
        </div>

        {feedback && (
          <div
            className={`p-3 rounded-2xl text-xs font-bold border transition-all ${
              feedback.type === "success"
                ? "bg-emerald-950/80 text-emerald-300 border-emerald-500/40"
                : "bg-rose-950/80 text-rose-300 border-rose-500/40"
            }`}
          >
            {feedback.message}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs font-bold font-tajawal">
          {/* Sequential Exam Title Selector */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-slate-300">
                عنوان التقييم المطلوب رصده *
              </label>
              <span className="text-[11px] text-amber-400 font-normal">
                (التقييم يكتب مرة واحدة فقط ولا يتكرر لنفس الطالب)
              </span>
            </div>

            {/* Quick Sequential Buttons (التقييم الأول، الثاني، الثالث...) */}
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {quickChips.map((title) => {
                const isSelected = examTitle === title;
                const isTaken = recordedExamsForSelected.includes(title);
                const isSuggested = selectedStudent && nextSuggestedForSelected === title;

                return (
                  <button
                    key={title}
                    type="button"
                    onClick={() => handleExamTitleChange(title)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1 border ${
                      isSelected
                        ? "bg-amber-400 text-slate-950 border-amber-300 shadow-md shadow-amber-500/20"
                        : isTaken
                        ? "bg-slate-900/60 text-slate-500 border-slate-800 line-through opacity-70"
                        : isSuggested
                        ? "bg-indigo-950/70 text-indigo-300 border-indigo-500/60 ring-1 ring-indigo-400"
                        : "bg-[#080d1e] text-slate-300 border-indigo-500/30 hover:border-amber-400/60"
                    }`}
                    title={isTaken ? `مسجل مسبقاً لهذا الطالب (غير قابل للتكرار)` : title}
                  >
                    <span>{title}</span>
                    {isTaken && <span className="text-[10px] no-underline">✓</span>}
                    {isSuggested && !isSelected && (
                      <span className="text-[10px] text-amber-400">✨</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Dropdown Selector for all 30 evaluations + custom text fallback */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
              <div className="relative">
                <select
                  value={STANDARD_EVALUATIONS.includes(examTitle) ? examTitle : "custom"}
                  onChange={(e) => {
                    if (e.target.value !== "custom") {
                      handleExamTitleChange(e.target.value);
                    }
                  }}
                  className="w-full bg-[#080d1e] border border-indigo-500/30 focus:border-amber-400 text-slate-100 px-3.5 py-2.5 rounded-2xl outline-none text-xs font-medium appearance-none cursor-pointer"
                >
                  <option value="" disabled>
                    اختر التقييم من القائمة المتسلسلة...
                  </option>
                  {STANDARD_EVALUATIONS.map((ev) => {
                    const taken = recordedExamsForSelected.includes(ev);
                    return (
                      <option key={ev} value={ev} className="bg-slate-900 text-white">
                        {ev} {taken ? "(مسجل مسبقاً ✓)" : ""}
                      </option>
                    );
                  })}
                  <option value="custom" className="bg-slate-900 text-amber-300">
                    -- كتابة اسم تقييم مخصص --
                  </option>
                </select>
                <ChevronDown className="w-4 h-4 text-slate-400 absolute left-3 top-3 pointer-events-none" />
              </div>

              <input
                type="text"
                required
                value={examTitle}
                onChange={(e) => handleExamTitleChange(e.target.value)}
                placeholder="اسم التقييم..."
                className="w-full bg-[#080d1e] border border-indigo-500/30 focus:border-amber-400 text-slate-100 px-3.5 py-2.5 rounded-2xl outline-none text-xs font-medium transition-all"
              />
            </div>
          </div>

          {/* Student Search */}
          <div className="space-y-1.5">
            <label className="text-slate-300 flex items-center justify-between">
              <span>ابحث باسم الطالب أو باركود الكارت:</span>
              <span className="text-[11px] text-amber-400 font-normal">
                يدعم البحث السريع (الاسم الأول والأخير وتخطي الأسماء الوسطى)
              </span>
            </label>
            <StudentSearchBox
              students={students}
              value={searchInput}
              onChange={(val) => {
                setSearchInput(val);
                if (!val) setSelectedStudent(null);
              }}
              onSelectStudent={handleSelectStudent}
              placeholder="اكتب اسم الطالب (مثال: أحمد علي) أو اضرب الباركود..."
              autoFocus
            />
          </div>

          {/* Selected Student Card & Anti-Duplication Status */}
          {selectedStudent && (
            <div className="space-y-2">
              <div className="glass-card border-emerald-500/40 p-4 rounded-2xl flex flex-wrap items-center justify-between gap-3 animate-in fade-in">
                <div>
                  <h4 className="text-sm font-bold text-emerald-300 font-fancy">
                    {selectedStudent.name}
                  </h4>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {selectedStudent.groupGrade} • {selectedStudent.groupDays} • باركود #{selectedStudent.barcode}
                  </p>
                </div>
                <div className="text-left font-mono text-xs text-amber-300">
                  ⭐ النقاط: {selectedStudent.points || 0}
                </div>
              </div>

              {/* Duplicate Prevention Alert */}
              {isCurrentExamDuplicate ? (
                <div className="p-3.5 rounded-2xl bg-rose-950/80 border border-rose-500/50 text-rose-200 flex flex-wrap items-center justify-between gap-2 animate-in fade-in">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                    <span className="text-xs font-bold">
                      ⚠️ تنبيه: تم رصد ({examTitle}) لهذا الطالب مسبقاً، ولا يمكن تكراره ثانية!
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleExamTitleChange(nextSuggestedForSelected)}
                    className="px-3 py-1.5 rounded-xl bg-amber-400 text-slate-950 text-xs font-black hover:bg-amber-300 transition cursor-pointer flex items-center gap-1 shadow-sm"
                  >
                    <RotateCcw className="w-3 h-3 text-slate-950" />
                    <span>الانتقال إلى ({nextSuggestedForSelected}) ⚡</span>
                  </button>
                </div>
              ) : (
                <div className="p-2.5 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 text-[11px] flex items-center justify-between">
                  <span>
                    التقييم المستحق للطالب: <strong className="text-white font-fancy">{examTitle}</strong> (غير مسجل مسبقاً ✓)
                  </span>
                  {recordedExamsForSelected.length > 0 && (
                    <span className="text-slate-400">
                      مسجل له سابقاً: {recordedExamsForSelected.length} تقييم
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-slate-300">الدرجة العظمى (الامتحان من كام) *</label>
              <input
                type="number"
                min={1}
                required
                value={maxScore}
                onChange={(e) => handleMaxScoreChange(Number(e.target.value))}
                placeholder="مثال: 10 أو 20 أو 50"
                className="w-full bg-[#080d1e] border border-indigo-500/30 text-slate-100 px-4 py-3 rounded-2xl font-mono text-sm outline-none font-bold focus:border-amber-400 transition-all"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-slate-300">درجة الطالب المحققة *</label>
              <input
                type="number"
                step="0.5"
                min={0}
                required
                value={studentScore}
                onChange={(e) => setStudentScore(e.target.value === "" ? "" : Number(e.target.value))}
                placeholder="مثال: 10 أو 9.5"
                className="w-full bg-[#080d1e] border border-amber-400 text-amber-300 font-black px-4 py-3 rounded-2xl text-lg outline-none font-mono focus:ring-2 focus:ring-amber-400/30 transition-all"
              />
            </div>
          </div>

          {studentScore !== "" && maxScore > 0 && (
            <div className="p-3.5 bg-slate-950/60 rounded-2xl text-center border border-indigo-500/20">
              <span className="text-slate-400 text-xs">النسبة المحققة: </span>
              <span className="text-lg font-black text-amber-300 font-mono">
                {Math.round((Number(studentScore) / maxScore) * 100)}%
              </span>
            </div>
          )}

          <button
            type="submit"
            disabled={!selectedStudent || isSubmitting || isCurrentExamDuplicate}
            className={`w-full py-3.5 rounded-2xl font-black text-sm transition-all flex items-center justify-center gap-2 shadow-xl ${
              selectedStudent && !isSubmitting && !isCurrentExamDuplicate
                ? "bg-gradient-to-r from-amber-400 via-amber-300 to-yellow-200 hover:from-amber-300 hover:to-yellow-100 text-slate-950 shadow-amber-500/25 cursor-pointer active:scale-[0.99]"
                : "bg-slate-800 text-slate-500 cursor-not-allowed opacity-50"
            }`}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-slate-950" />
                <span>جارٍ رصد النتيجة...</span>
              </>
            ) : isCurrentExamDuplicate ? (
              <>
                <AlertTriangle className="w-4 h-4 text-rose-400" />
                <span>الامتحان مسجل مسبقاً لهذا الطالب (غير مسموح بالتكرار)</span>
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4 text-slate-950" />
                <span>حفظ ورصد درجة الامتحان بالمنصة ✅</span>
              </>
            )}
          </button>
        </form>

        {/* Last Recorded Student Feedback Toast / Banner */}
        {lastRecordedInfo && (
          <div className="p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex flex-wrap items-center justify-between gap-3 animate-in fade-in">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-emerald-500/20 text-emerald-400">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs font-bold text-emerald-300 font-fancy">
                  تم رصد وتوثيق نتيجة: {lastRecordedInfo.studentName} ({lastRecordedInfo.grade})
                </p>
                <p className="text-[11px] text-slate-300 font-tajawal mt-0.5">
                  الامتحان: <span className="text-amber-300 font-bold">{lastRecordedInfo.examTitle}</span> • الدرجة:{" "}
                  <span className="font-mono text-emerald-300 font-bold">
                    {lastRecordedInfo.score}/{lastRecordedInfo.maxScore} ({lastRecordedInfo.percentage}%)
                  </span>
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              {onClearGrade && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`هل أنت متأكد من التراجع ومسح درجة الطالب (${lastRecordedInfo.studentName}) التي تم رصدها للتو؟`)) {
                      onClearGrade(lastRecordedInfo.barcode);
                      setFeedback({ type: "success", message: `تم مسح درجة (${lastRecordedInfo.studentName}) وإلغاء الرصد بنجاح!` });
                      setLastRecordedInfo(null);
                    }
                  }}
                  className="px-3 py-1.5 rounded-xl bg-rose-600/20 hover:bg-rose-600/40 border border-rose-500/40 text-rose-300 text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer shadow-sm active:scale-95"
                  title="التراجع ومسح هذه الدرجة فوراً"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>تراجع ومسح الدرجة</span>
                </button>
              )}

              {lastRecordedInfo.phone && lastRecordedInfo.message && (
                <button
                  type="button"
                  onClick={() => openWhatsApp(lastRecordedInfo.phone!, lastRecordedInfo.message!)}
                  className="px-3 py-1.5 rounded-xl bg-emerald-600/30 hover:bg-emerald-600/50 border border-emerald-400/40 text-emerald-300 text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
                  title="خيار جانبي يدوي: فتح واتساب ولي الأمر وإرسال النتيجة"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>إرسال واتساب يدوي</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
