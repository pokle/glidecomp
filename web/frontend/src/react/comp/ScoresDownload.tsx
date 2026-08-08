/**
 * "Download" menu on the competition scores page: the scores as a CSV, and the
 * same file opened live in Google Sheets.
 *
 * Both point at ONE URL — `/comp/<slug>-<id>/scores.csv`, served by the SSR
 * Pages Function from the same loader the page renders from (see
 * functions/comp/[[path]].ts + src/scores-csv.ts). The download is therefore a
 * plain link: no blob, no JS, right-clickable, and identical to what a
 * spreadsheet pulling from the URL sees.
 *
 * The Sheets route is IMPORTDATA rather than an upload because Google has no
 * "create a sheet from this URL" link to send someone to — but a formula in A1
 * does better than an upload anyway: the sheet re-reads the URL periodically,
 * so a re-scored task shows up without anyone re-exporting anything. It fetches
 * anonymously, which is why a hidden `test` comp says so instead of silently
 * handing back a broken sheet.
 */
import { useState } from "react";
import { DownloadIcon, ChevronDownIcon, TableIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/react/rac/alert";
import { Button, LinkButton } from "@/react/rac/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle, Modal } from "@/react/rac/dialog";
import { Menu, MenuItem, MenuTrigger } from "@/react/rac/menu";
import { compScoresCsvPath } from "../lib/slug";
import { toast } from "../lib/toast";

export function ScoresDownload({
  compId,
  compName,
  /** Hidden (`test`) comp — Google fetches anonymously and would get a 404. */
  isTestComp = false,
}: {
  compId: string;
  compName: string;
  isTestComp?: boolean;
}) {
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

  return (
    <>
      <MenuTrigger>
        <Button variant="outline" size="sm">
          <DownloadIcon aria-hidden />
          Download
          <ChevronDownIcon className="opacity-60" aria-hidden />
        </Button>
        <Menu placement="bottom end">
          {/* `download` (no value) forces a save and takes the server's
              Content-Disposition filename. */}
          <MenuItem href={csvPath} download="">
            <DownloadIcon aria-hidden />
            CSV spreadsheet
          </MenuItem>
          <MenuItem onAction={() => setSheetsOpen(true)}>
            <TableIcon aria-hidden />
            Open in Google Sheets…
          </MenuItem>
        </Menu>
      </MenuTrigger>

      <Modal isOpen={sheetsOpen} onOpenChange={setSheetsOpen} className="sm:max-w-lg">
        <Dialog className="gap-3">
          <DialogHeader>
            <DialogTitle>Open in Google Sheets</DialogTitle>
            <p className="text-sm text-muted-foreground">
              One formula, kept up to date — a re-score turns up without
              another download.
            </p>
          </DialogHeader>

          {isTestComp ? (
            <Alert variant="destructive">
              <AlertTitle>This competition is hidden</AlertTitle>
              <AlertDescription>
                Google fetches the file signed out, so it will get “not found”.
                Download the CSV instead, or publish the competition first.
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

          <DialogFooter>
            <Button onPress={() => void copyFormula()}>
              {copied ? "Copied!" : "Copy formula"}
            </Button>
            <LinkButton
              variant="outline"
              href="https://sheets.new"
              target="_blank"
              rel="noopener noreferrer"
            >
              New Google Sheet
            </LinkButton>
            <Button slot="close" variant="ghost">
              Done
            </Button>
          </DialogFooter>
        </Dialog>
      </Modal>
    </>
  );
}
