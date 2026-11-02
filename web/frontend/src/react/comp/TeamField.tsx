/**
 * The pilot sheet's Team field: a combo box over the roster's teams.
 *
 * Teams are scored by their exact name, so a typo published a second team
 * with its own total. This field makes the roster's own spelling the easy
 * thing to enter (comp/team-names.ts has the matching):
 *
 *   - **It lists the teams there are**, each with its pilot count, narrowing
 *     as you type. Usually you pick one.
 *   - **A new team is a deliberate choice.** A name that is no team appears at
 *     the foot of the list as "New team: …", and the sheet will not save one
 *     until it is chosen (PilotSheet's `validate`).
 *   - **A near miss is caught.** A name a slip away from a team is offered as
 *     "Did you mean …?" above "New team". A name that differs only in case,
 *     spacing or accents simply IS that team, and saves under its spelling.
 *
 * Opens on focus, so the teams are in front of the organiser before they
 * type a letter, and on a tap (the kit's field variant), so a list that Esc
 * or a scroll closed comes back without typing.
 */
import { useMemo } from "react";
import { ComboBox, ComboBoxItem } from "@/react/rac/combo-box";
import { useFormState } from "@/react/rac/form";
import { teamOptions, type RosterTeam, type TeamOption } from "./team-names";

export function TeamField({
  value,
  onChange,
  teams,
  onNewTeam,
}: {
  value: string;
  onChange: (value: string) => void;
  teams: RosterTeam[];
  /** The organiser chose "New team" for this name. */
  onNewTeam: (name: string) => void;
}) {
  // Memoised: React Aria rebuilds the whole list for a new `items` array, and
  // a fresh one on every render kept the options detaching from under a tap.
  const options = useMemo(() => teamOptions(value, teams), [value, teams]);
  const { clearFieldError } = useFormState();

  return (
    <ComboBox<TeamOption>
      variant="field"
      label="Team"
      name="team_name"
      menuTrigger="focus"
      allowsCustomValue
      inputValue={value}
      onInputChange={onChange}
      items={options}
      // Nothing to offer for an empty field on a roster with no teams yet.
      allowsEmptyCollection={false}
      onSelectionChange={(key) => {
        const option = options.find((o) => o.id === key);
        if (!option) return;
        // Choosing a row puts its name in the field (its textValue); a new
        // team is also remembered as chosen, which is what lets it save.
        onChange(option.name);
        if (option.kind === "new") onNewTeam(option.name);
        // A choice from the list answers "Choose a team…" at once.
        clearFieldError("team_name");
      }}
    >
      {(option) => (
        <ComboBoxItem id={option.id} textValue={option.name}>
          {option.kind === "team" ? (
            <>
              <span>{option.name}</span>
              <span className="text-xs text-muted-foreground">({option.count})</span>
            </>
          ) : option.kind === "near" ? (
            <span>Did you mean {option.name}?</span>
          ) : (
            <span className="font-medium">New team: {option.name}</span>
          )}
        </ComboBoxItem>
      )}
    </ComboBox>
  );
}
