/**
 * The scannable XCTrack `XCTSK:` QR for a competition's waypoint set (issue
 * #312, stage 2). Pilots point their flight app (Flyskyhy, XCTrack, …) at it to
 * load every turnpoint at once — no cable, no file transfer.
 *
 * Lazy-loaded so `qrcode.react` stays out of the main/SSR bundle: the waypoints
 * page is statically imported into the route tree, and only this leaf needs the
 * QR library.
 */
import { QRCodeSVG } from "qrcode.react";

export default function WaypointQR({ value }: { value: string }) {
  return (
    <div className="inline-flex flex-col items-center gap-2 rounded-lg border border-border bg-white p-4">
      <QRCodeSVG
        value={value}
        // Error-correction level L maximises data capacity; the code is read
        // from a screen at close range where low EC is fine.
        level="L"
        marginSize={2}
        size={280}
        className="h-auto w-full max-w-[280px]"
      />
    </div>
  );
}
