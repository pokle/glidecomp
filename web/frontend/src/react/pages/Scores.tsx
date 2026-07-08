/**
 * /scores is retired as a destination (IA v2 #277): competition scores live
 * inline on the comp page, which is the canonical scores surface. Old links
 * (/scores?comp_id=X) land on /comp/X#scores.
 */
import { Navigate, useSearchParams } from "react-router-dom";

export function Scores() {
  const [searchParams] = useSearchParams();
  const compId = searchParams.get("comp_id");
  return (
    <Navigate
      to={compId ? `/comp/${encodeURIComponent(compId)}#scores` : "/comp"}
      replace
    />
  );
}
