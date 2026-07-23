/**
 * /scores is retired as a destination: each competition has its own scores
 * page at /comp/:id/scores. Old links (/scores?comp_id=X) land there.
 */
import { Navigate, useSearchParams } from "react-router-dom";

export function Scores() {
  const [searchParams] = useSearchParams();
  const compId = searchParams.get("comp_id");
  return (
    <Navigate
      to={compId ? `/comp/${encodeURIComponent(compId)}/scores` : "/comp"}
      replace
    />
  );
}
