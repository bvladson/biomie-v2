import { useEffect } from "react";
import { createFloatingTableScroll } from "@/lib/floating-table-scroll";

/** Start after hydration and clean up on logout/unmount, including React StrictMode. */
export function GlobalFloatingTableScroll() {
  useEffect(() => {
    const scroll = createFloatingTableScroll();
    scroll.init();
    return () => scroll.destroy();
  }, []);

  return null;
}
