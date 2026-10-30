import type { ReactNode } from "react";

// Only the surrounding title/layout module is replaced to avoid server imports.
// All PositionsPage controls, columns, rows and shared Table stay production code.
export function PageTitle({ title, description, children }: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return <div className="fixture-page-title"><div><h1>{title}</h1><p>{description}</p></div>{children}</div>;
}
