/**
 * React Aria Components Button/Link, styled to match ui/button.tsx.
 *
 * Part of the RAC exploration kit (src/react/rac/): the task detail page is
 * built entirely from these primitives to evaluate react-aria-components as
 * the app-wide component foundation. Interaction states use RAC's data
 * attributes (data-hovered / data-pressed / data-focus-visible) instead of CSS
 * pseudo-classes — RAC normalizes them across mouse/touch/keyboard.
 */
import {
  Button as AriaButton,
  Link as AriaLink,
  ToggleButton as AriaToggleButton,
  type ButtonProps as AriaButtonProps,
  type LinkProps as AriaLinkProps,
  type ToggleButtonProps as AriaToggleButtonProps,
} from "react-aria-components";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/react/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none data-focus-visible:border-ring data-focus-visible:ring-3 data-focus-visible:ring-ring/50 data-pressed:translate-y-px data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground data-hovered:bg-primary/80",
        outline:
          "border-border bg-background data-hovered:bg-muted data-hovered:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground data-selected:bg-primary data-selected:text-primary-foreground dark:border-input dark:bg-input/30 dark:data-hovered:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground data-hovered:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
        ghost:
          "data-hovered:bg-muted data-hovered:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:data-hovered:bg-muted/50",
        destructive:
          "bg-destructive/10 text-destructive data-hovered:bg-destructive/20 data-focus-visible:border-destructive/40 data-focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:data-hovered:bg-destructive/30 dark:data-focus-visible:ring-destructive/40",
        link: "text-primary underline-offset-4 data-hovered:underline",
      },
      size: {
        default: "h-8 gap-1.5 px-2.5",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5",
        icon: "size-8",
        "icon-sm": "size-7 rounded-[min(var(--radius-md),12px)]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

type ButtonVariants = VariantProps<typeof buttonVariants>;

export function Button({
  className,
  variant,
  size,
  ...props
}: Omit<AriaButtonProps, "className"> & ButtonVariants & { className?: string }) {
  return (
    <AriaButton
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

/** An anchor (RAC Link) with button styling — for "open another page" actions. */
export function LinkButton({
  className,
  variant,
  size,
  ...props
}: Omit<AriaLinkProps, "className"> & ButtonVariants & { className?: string }) {
  return (
    <AriaLink
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

/** Two-state press button (RAC ToggleButton) — e.g. the map's add-mode. */
export function ToggleButton({
  className,
  variant = "outline",
  size,
  ...props
}: Omit<AriaToggleButtonProps, "className"> & ButtonVariants & { className?: string }) {
  return (
    <AriaToggleButton
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
