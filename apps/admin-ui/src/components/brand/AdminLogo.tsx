import Image from "next/image";
import Link from "next/link";
export function AdminLogo() {
  return (
    <Link
      href="/"
      className="inline-flex w-fit shrink-0 rounded-lg"
      aria-label="probabl operations home"
    >
      <Image
        src="/brand/logo-name.svg"
        alt="probabl"
        unoptimized
        width={144}
        height={25}
        className="h-auto w-28 sm:w-36"
      />
    </Link>
  );
}
