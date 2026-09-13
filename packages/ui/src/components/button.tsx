import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "../lib/utils.ts";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[11px] border border-transparent bg-clip-padding text-sm font-semibold tracking-[-0.015em] whitespace-nowrap shadow-none transition-all outline-none select-none hover:-translate-y-px focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover hover:shadow-lg",
        brand: "bg-primary text-primary-foreground hover:bg-primary-hover hover:shadow-lg",
        outline: "border-input bg-background hover:bg-muted hover:text-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/75",
        ghost: "hover:bg-muted hover:text-foreground",
        destructive: "bg-danger-soft text-danger hover:underline",
        link: "text-brand-strong underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 gap-2 px-4",
        xs: "h-6 gap-1 rounded-lg px-2 text-xs [&_svg]:size-3",
        sm: "h-8 gap-1.5 rounded-[9px] px-3 text-[0.8rem] [&_svg]:size-3.5",
        lg: "h-12 gap-2 px-5 text-[15px]",
        icon: "size-10",
        "icon-sm": "size-8 rounded-[9px]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
