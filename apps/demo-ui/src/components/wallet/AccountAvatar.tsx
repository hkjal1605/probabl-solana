import BoringAvatar from "boring-avatars";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export function AccountAvatar({
  account,
  size = "default",
}: {
  account: string;
  size?: "default" | "header";
}) {
  return (
    <Avatar
      size="default"
      className={
        size === "header"
          ? "size-5 overflow-hidden after:hidden sm:size-[25px]"
          : "overflow-hidden after:hidden"
      }
    >
      <AvatarFallback className="bg-transparent">
        <BoringAvatar
          name={account}
          variant="marble"
          size="100%"
          className="size-full"
          aria-hidden="true"
        />
      </AvatarFallback>
    </Avatar>
  );
}
