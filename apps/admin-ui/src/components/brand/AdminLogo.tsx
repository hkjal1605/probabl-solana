import { BrandLogo } from "@conditional-stocks/ui-kit/brand-logo";
import Link from "next/link";
export function AdminLogo() {
  return (
    <Link
      href="/"
      className="inline-flex w-fit shrink-0 rounded-lg"
      aria-label="probabl operations home"
    >
      <BrandLogo />
    </Link>
  );
}
