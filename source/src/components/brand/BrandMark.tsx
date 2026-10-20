import { cn } from "@/lib/utils";

/**
 * BIOMIE mark: the original logo artwork from the identity manual (20/10/2026),
 * only scaled, never recolored or redrawn. It sits next to the "BIOMIE" wordmark,
 * so it is decorative for screen readers.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      src="/brand/biomie-icon-64.png"
      alt=""
      aria-hidden="true"
      width={64}
      height={64}
      decoding="async"
      draggable={false}
      className={cn("object-contain select-none", className)}
    />
  );
}
