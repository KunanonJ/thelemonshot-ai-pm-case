import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

// Minimal kit: hairline borders, neutral greys, one near-black primary, no shadows

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" };

export function Button({ variant = "secondary", size = "md", className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
        variant === "primary" && "bg-neutral-900 text-white hover:bg-neutral-800",
        variant === "secondary" && "border border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-50",
        variant === "ghost" && "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
        variant === "danger" && "border border-red-200 bg-white text-red-700 hover:bg-red-50",
        className,
      )}
    />
  );
}

type Tone = "neutral" | "green" | "amber" | "red" | "blue";
const TONES: Record<Tone, string> = {
  neutral: "bg-neutral-100 text-neutral-700",
  green: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-800",
  red: "bg-red-50 text-red-700",
  blue: "bg-sky-50 text-sky-700",
};

export function Pill({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap", TONES[tone])}>
      {children}
    </span>
  );
}

export const STATUS_TONE: Record<string, Tone> = {
  queued: "neutral",
  running: "blue",
  draft: "amber",
  approved: "green",
  rejected: "red",
  failed: "red",
  pending: "neutral",
  ok: "green",
  partial: "amber",
  pass: "green",
  fail: "red",
  waiting: "neutral",
};

export function StatusPill({ status }: { status: string }) {
  return <Pill tone={STATUS_TONE[status] ?? "neutral"}>{status[0]!.toUpperCase() + status.slice(1)}</Pill>;
}

// HR-1: every surface that shows the roster says it is sample data
export function SampleDataPill() {
  return (
    <Pill tone="amber" title="Public creator profiles used for demonstration, not an agency database">
      Sample data
    </Pill>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-lg border border-neutral-200 bg-white", className)}>{children}</div>;
}

export function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-neutral-500">{hint}</div>}
    </Card>
  );
}

export function Banner({ tone = "amber", title, children }: { tone?: "amber" | "red" | "neutral"; title: string; children?: ReactNode }) {
  return (
    <div
      className={cx(
        "rounded-lg border px-4 py-3 text-[13px]",
        tone === "amber" && "border-amber-200 bg-amber-50/60 text-amber-900",
        tone === "red" && "border-red-200 bg-red-50/60 text-red-900",
        tone === "neutral" && "border-neutral-200 bg-neutral-50 text-neutral-700",
      )}
    >
      <div className="font-medium">{title}</div>
      {children && <div className="mt-0.5 opacity-90">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[13px] font-medium text-neutral-800">{label}</div>
      {children}
      {hint && <div className="mt-1 text-xs text-neutral-500">{hint}</div>}
    </label>
  );
}

const inputBase =
  "w-full rounded-md border border-neutral-200 bg-white px-2.5 text-[13px] text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputBase, "h-8", props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputBase, "py-2", props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(inputBase, "h-8", props.className)} />;
}

export function Spinner() {
  return <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-800" />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-200 px-6 py-12 text-center">
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-md text-[13px] text-neutral-500">{children}</div>}
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cx("h-8 px-3 text-left text-xs font-normal text-neutral-500", className)}>{children}</th>;
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx("px-3 py-2.5 align-top text-[13px]", className)}>{children}</td>;
}

export function Drawer({ open, title, onClose, children, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-neutral-900/20" onClick={onClose}>
      <div className={cx("h-full w-full overflow-y-auto border-l border-neutral-200 bg-white", wide ? "max-w-2xl" : "max-w-md")} onClick={(e) => e.stopPropagation()}>
        <div className="flex h-14 items-center justify-between border-b border-neutral-200 px-5">
          <div className="text-sm font-semibold">{title}</div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
