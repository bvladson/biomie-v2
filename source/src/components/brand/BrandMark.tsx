import { cn } from "@/lib/utils";

/** BIOMIE mark: ascending bars inside a rounded square. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("text-primary", className)} aria-hidden>
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <rect
        x="8"
        y="17"
        width="3.5"
        height="7"
        rx="1.2"
        className="fill-primary-foreground"
        opacity="0.6"
      />
      <rect
        x="14.25"
        y="12"
        width="3.5"
        height="12"
        rx="1.2"
        className="fill-primary-foreground"
        opacity="0.8"
      />
      <rect x="20.5" y="7" width="3.5" height="17" rx="1.2" className="fill-primary-foreground" />
    </svg>
  );
}
