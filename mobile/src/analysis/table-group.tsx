import { reportCellText } from '@glidecomp/client/analysis';
import type { ReportTable } from '@glidecomp/engine';

import { Group, Note, Row } from '@/ui/grouped-list';

/**
 * A metric's report table as a group of rows — the exact reading under every
 * chart. A table is many columns and a phone is one: each row's first cell
 * is its title, and the rest are "header value" pairs on the line under it,
 * so nothing scrolls sideways. A plain function to CALL, not a component
 * (mobile/CLAUDE.md, "Lists").
 */
export function tableGroup(table: ReportTable, timeZone: string | null, key: string) {
  const rest = table.columns.slice(1);
  return (
    <Group key={key} title={table.title}>
      {table.rows.map((cells, i) => {
        const [head, ...others] = cells;
        const detail = others
          .map((c, j) => {
            const text = reportCellText(c, timeZone);
            return text ? `${rest[j]?.header ?? ''} ${text}`.trim() : null;
          })
          .filter(Boolean)
          .join(' · ');
        return (
          <Row
            key={i}
            title={head === undefined ? '' : reportCellText(head, timeZone)}
            detail={detail || undefined}
          />
        );
      })}
      {(table.footnotes ?? []).map((f, i) => (
        <Note key={`f${i}`}>{f}</Note>
      ))}
    </Group>
  );
}
