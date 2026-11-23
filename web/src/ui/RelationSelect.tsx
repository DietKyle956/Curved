import type { RelationCandidate } from "../domain/presentation.ts";
import { Field } from "./ui.tsx";

export function RelationSelect({
  label,
  hint,
  candidates,
  value,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  candidates: RelationCandidate[];
  value: string[];
  onChange: (keys: string[]) => void;
  testId: string;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <select
          id={id}
          multiple
          size={Math.min(Math.max(candidates.length, 3), 6)}
          value={value}
          data-testid={testId}
          className="field-input min-h-24"
          onChange={(event) => {
            onChange(
              Array.from(event.target.selectedOptions, (option) => option.value),
            );
          }}
        >
          {candidates.map((candidate) => (
            <option key={candidate.key} value={candidate.key}>
              {candidate.title.length === 0
                ? candidate.key
                : `${candidate.key} · ${candidate.title}`}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
