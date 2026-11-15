/**
 * The competition scores page's downloads, as rows of its bar's ⋯ menu (issue
 * #863; a "Download" menu button on the page until then): the scores as a
 * CSV, the same file opened live in Google Sheets, the results record — a PDF
 * of every class, team and task to keep (src/results-record/) — and the data
 * that PDF carries, as a ZIP for a viewer that cannot open its attachments.
 * Open to everyone, like the page: inside the menu they add no clutter, and a
 * pilot keeping their own copy of a comp is as welcome as its scorer.
 *
 * The first two point at ONE URL — `/comp/<slug>-<id>/scores.csv`, served by the SSR
 * Pages Function from the same loader the page renders from (see
 * functions/comp/[[path]].ts + src/scores-csv.ts). The download is therefore a
 * plain link: no blob, no JS, right-clickable, and identical to what a
 * spreadsheet pulling from the URL sees.
 *
 * The Sheets route is IMPORTDATA rather than an upload because Google has no
 * "create a sheet from this URL" link to send someone to — but a formula in A1
 * does better than an upload anyway: the sheet re-reads the URL periodically,
 * so a re-scored task shows up without anyone re-exporting anything. It fetches
 * anonymously, which works for a hidden `test` comp too: `compId` carries the
 * comp's share key there (lib/slug.ts `compUrlId`), so the formula's URL is the
 * comp's private link, and the dialog says so.
 */
import { useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/react/rac/alert";
import { Button, LinkButton } from "@/react/rac/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle, Modal } from "@/react/rac/dialog";
import type { BarAction } from "@/react/rac/page-bar";
import { compScoresCsvPath, compScoresPdfPath, compScoresZipPath } from "../lib/slug";
import { toast } from "../lib/toast";

/**
 * The four download rows for the bar's ⋯, and the Google Sheets dialog one of
 * them opens: render `dialog` anywhere in the page.
 */
export function useScoresDownload({
  compId,
  compName,
  /** Hidden (`test`) comp — the formula then holds the comp's private link. */
  isTestComp = false,
}: {
  /** As it goes in URLs (`compUrlId`): a hidden comp's share key rides along. */
  compId: string;
  compName: string | null | undefined;
  isTestComp?: boolean;
}): { actions: BarAction[]; dialog: ReactNode } {
  const [sheetsOpen, setSheetsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const csvPath = compScoresCsvPath(compId, compName);
  // Only read in the dialog, which never renders on the server.
  const formula = () =>
    `=IMPORTDATA("${typeof window === "undefined" ? "" : window.location.origin}${csvPath}")`;

  async function copyFormula() {
    try {
      await navigator.clipboard.writeText(formula());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy — select the formula and copy it by hand.");
    }
  }

  // `download` (no value) forces a save and takes the server's
  // Content-Disposition filename.
  const actions: BarAction[] = [
    { id: "csv", label: "CSV spreadsheet", to: csvPath, download: true },
    { id: "sheets", label: "Open in Google Sheets…", onAction: () => setSheetsOpen(true) },
    {
      id: "pdf",
      label: "Results record (PDF)",
      to: compScoresPdfPath(compId, compName),
      download: true,
    },
    {
      id: "zip",
      label: "Results data (ZIP)",
      to: compScoresZipPath(compId, compName),
      download: true,
    },
  ];

  const dialog = (
      <Modal isOpen={sheetsOpen} onOpenChange={setSheetsOpen} className="sm:max-w-lg">
        <Dialog className="gap-3">
          <DialogHeader>
            <DialogTitle>Open in Google Sheets</DialogTitle>
            <p className="text-sm text-muted-foreground">
              One formula that stays current — no re-downloading after a
              re-score.
            </p>
          </DialogHeader>

          {isTestComp ? (
            <Alert>
              <AlertDescription>
                This formula includes the competition’s private link. Anyone
                who can open the sheet can open the competition.
              </AlertDescription>
            </Alert>
          ) : null}

          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Open a blank sheet at{" "}
              <a
                href="https://sheets.new"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4"
              >
                sheets.new
              </a>
              .
            </li>
            <li>Paste this into cell A1:</li>
          </ol>
          <code className="block rounded-md border bg-muted px-3 py-2 font-mono text-xs break-all">
            {formula()}
          </code>

          <p className="text-sm text-muted-foreground">
            One row per pilot per task. Every row links back to its score.
          </p>

          {/* Done · New Google Sheet · Copy formula: the main action is last
              (issue #863), and on a phone, where the footer stacks from the
              bottom up, on top. */}
          <DialogFooter>
            <Button slot="close" variant="ghost">
              Done
            </Button>
            <LinkButton
              variant="outline"
              href="https://sheets.new"
              target="_blank"
              rel="noopener noreferrer"
            >
              New Google Sheet
            </LinkButton>
            <Button onPress={() => void copyFormula()}>
              {copied ? "Copied!" : "Copy formula"}
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
  );

  return { actions, dialog };
}
