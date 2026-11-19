/**
 * A list whose every item is a reading: a name, a figure or two, and a mark
 * on an axis the whole list shares (rac/meter.tsx).
 *
 * Each item is a CARD of its own, with a gap between one and the next. These
 * lists were first rows inside one card, divided by a hairline, which is
 * right for a row of one line. With a name, a chip, a track and a line of
 * words in every row, a reader scrolling past could not tell whether a track
 * belonged to the name above it or the name below. A gap that shows the
 * page's ground answers that; so does the name in bold, which reads as the
 * start of an item.
 *
 * The list's heading, its lede and its axis sit above the cards on the
 * ground, not in a card of their own. So the section that holds one of these
 * lists is a plain `<section>`, never a `<Card>`: a card inside a card is
 * white on white and the gap shows nothing.
 *
 * Two shapes, one look:
 * - {@link ReadingRows} / {@link ReadingRow}: a plain list, for rows that are
 *   links or nothing.
 * - {@link READING_TABLE}: classes that lay a kit `Table` out the same way,
 *   for a list that needs the table's selection and keyboard.
 */
import { ChevronRightIcon } from "lucide-react";
import { Link as AriaLink, type LinkProps } from "react-aria-components";
import { cn } from "@/react/lib/utils";
import { cardSurface } from "./card";

/** The card a row is. `relative`, for a link stretched over it. */
const rowCard = cn(cardSurface, "relative px-5 py-3.5 text-base");

/** The room a row keeps on its right for the chevron of {@link ReadingRowLink}.
 * The axis above the list keeps the same room, so it lines up with the tracks. */
export const READING_LINK_ROOM = "pr-11";

/** The side padding of a row, for the axis above the list to match. */
export const READING_AXIS_INSET = "px-5";

export function ReadingRows({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul className={cn("flex flex-col gap-2.5", className)} {...props} />;
}

export function ReadingRow({ className, ...props }: React.ComponentProps<"li">) {
  return <li className={cn(rowCard, className)} {...props} />;
}

/** A row's name: bold, so it reads as the start of the item. */
export const READING_NAME = "font-semibold";

/**
 * The one link of a row, stretched over the whole row, with the chevron at
 * the row's right-hand edge. A real anchor, so it works with JavaScript off
 * (docs/ssr.md), and the row is the target, not the name.
 *
 * `after:z-10`: a track's own boxes are positioned and come later in the
 * row, so without it they sit over the link and a tap on the track opens
 * nothing. The row needs `relative` and {@link READING_LINK_ROOM}.
 */
export function ReadingRowLink({
  className,
  children,
  ...props
}: Omit<LinkProps, "className" | "children"> & {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <AriaLink
      className={cn(
        "outline-none after:absolute after:inset-0 after:z-10 after:rounded-xl",
        "data-focus-visible:after:ring-2 data-focus-visible:after:ring-ring/50",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon
        aria-hidden="true"
        className="absolute top-1/2 right-4 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </AriaLink>
  );
}

/**
 * Classes that lay a kit `Table` out as this list: the table, its head and
 * its body are blocks, the body is a column of cards, and a row is a grid
 * whose areas the caller names. Pass `viewport` as the table's
 * `viewportClassName`: the kit's viewport scrolls sideways, which clips a
 * card's shadow, and this list never scrolls.
 *
 * The kit's body removes its last row's border, which here would open the
 * last card's box, so the table puts it back.
 */
export const READING_TABLE = {
  viewport: "overflow-visible",
  table:
    "block [&_thead]:block [&_tbody]:flex [&_tbody]:flex-col [&_tbody]:gap-2.5 [&_tbody_tr:last-child]:border",
  header:
    "border-0 [&_tr]:flex [&_tr]:flex-wrap [&_tr]:items-center [&_tr]:gap-x-4 [&_tr]:px-5 [&_tr]:pb-2",
  heading: "block h-auto p-0 text-muted-foreground",
  row: cn(
    rowCard,
    "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 data-selected:border-foreground/50"
  ),
  cell: "block p-0",
  name: cn(READING_NAME, "whitespace-normal text-base"),
};
