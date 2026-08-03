/**
 * React Aria Components Menu, styled to match the shadcn kit it replaced. MenuItems
 * accept `href` (+ download/target) so "download in format X" entries are real
 * links with menu keyboard semantics.
 */
import {
  MenuTrigger,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  Header as AriaHeader,
  Separator as AriaSeparator,
  Popover,
  type MenuProps as AriaMenuProps,
  type MenuItemProps,
  type MenuSectionProps,
  type PopoverProps,
  type SeparatorProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { popoverClass } from "./select";

export function Menu<T extends object>({
  className,
  placement,
  ...props
}: Omit<AriaMenuProps<T>, "className"> & {
  className?: string;
  /** Forwarded to the wrapping Popover — e.g. "bottom end" to right-align. */
  placement?: PopoverProps["placement"];
}) {
  return (
    <Popover className={cn(popoverClass, "min-w-44")} placement={placement}>
      <AriaMenu className={cn("outline-none", className)} {...props} />
    </Popover>
  );
}

export function MenuItem({
  className,
  ...props
}: Omit<MenuItemProps, "className"> & { className?: string }) {
  return (
    <AriaMenuItem
      className={cn(
        "flex w-full cursor-default items-center gap-1.5 rounded-md px-1.5 py-1 text-sm outline-none select-none",
        "data-focused:bg-accent data-focused:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

/**
 * A labelled group of items. RAC needs the `Header` to sit inside a
 * `MenuSection` for it to be wired up as the group's accessible name — a bare
 * Header in the Menu is just text (the same trap Base UI's GroupLabel had).
 */
export function MenuSection<T extends object>({
  className,
  ...props
}: Omit<MenuSectionProps<T>, "className"> & { className?: string }) {
  return <AriaMenuSection className={cn("outline-none", className)} {...props} />;
}

export function MenuHeader({
  className,
  ...props
}: React.ComponentProps<typeof AriaHeader>) {
  return (
    <AriaHeader
      className={cn("px-1.5 py-1 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export function MenuSeparator({
  className,
  ...props
}: Omit<SeparatorProps, "className"> & { className?: string }) {
  return <AriaSeparator className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export { MenuTrigger };
