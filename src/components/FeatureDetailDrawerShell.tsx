import { useEffect } from "react";
import type { ReactNode } from "react";
import { X } from "lucide-react";

import type { Feature } from "../types";
import { answerTypeLabel, useAnalysisFilters } from "../analysisFilters";
import { ConceptLabel, VerifiedBadge } from "./ui";

export default function FeatureDetailDrawerShell({
  kind,
  featureId,
  feature,
  onClose,
  children,
}: {
  kind: "response" | "prompt";
  featureId: number;
  feature?: Feature;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const response = kind === "response";
  const { filters } = useAnalysisFilters();
  const activeFilters = [
    ...(filters.group ? [`${filters.groupColumn}: ${filters.group}`] : []),
    ...(response && filters.answerType !== "all"
      ? [`answer type: ${answerTypeLabel(filters.answerType)}`]
      : []),
  ];
  const closeLabel = response ? "Close concept details" : "Close prompt concept details";
  const ariaLabel = response
    ? `Concept ${featureId} details`
    : `Prompt concept ${featureId} details`;

  return (
    <div
      className="fixed inset-0 z-[80] flex justify-end bg-[#02050b]/70 backdrop-blur-[3px]"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className="relative h-full w-full overflow-y-auto border-l border-edge/90 bg-[#0a0f19] shadow-[-24px_0_70px_rgba(0,0,0,0.45)] sm:w-[min(88vw,860px)]"
      >
        <div className="sticky top-0 z-20 border-b border-edge/90 bg-[#0a0f19]/95 px-5 py-5 backdrop-blur-xl sm:px-7">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/80 to-transparent" />
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent-soft">
                {response ? "Answer concept evidence" : "Prompt concept evidence"}
              </div>
              <h2 className="mt-1.5 text-xl font-semibold leading-snug tracking-tight text-slate-50 sm:text-2xl">
                <ConceptLabel id={featureId} name={feature?.concept} wrap />
              </h2>
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
                <VerifiedBadge pass={feature?.fidelity_pass} n={feature?.fidelity_n} />
                <span className="font-mono text-[11px] text-slate-500">feature #{featureId}</span>
                <span className="text-[11px] text-slate-600">
                  {activeFilters.length
                    ? "filtered examples · dataset-wide relationship numbers"
                    : "dataset examples · dataset-wide relationships"}
                </span>
              </div>
              {activeFilters.length > 0 && (
                <p className="mt-2 text-[11px] text-slate-400">
                  Using {activeFilters.join(" · ")}. Relationship percentages and counts still use the full dataset.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              autoFocus
              aria-label={closeLabel}
              className="icon-button grid shrink-0"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="space-y-5 p-4 sm:p-7">{children}</div>
      </aside>
    </div>
  );
}
