import { useState } from "react";
import type { FormEvent } from "react";

import { relationCandidates } from "../domain/presentation.ts";
import type { Issue } from "../domain/types.ts";
import { Dialog } from "./Dialog.tsx";
import { RelationSelect } from "./RelationSelect.tsx";
import { Button } from "./ui.tsx";

export function RelationsDialog({
  issue,
  issues,
  onClose,
  onSave,
}: {
  issue: Issue;
  issues: Issue[];
  onClose: () => void;
  onSave: (
    key: string,
    relations: { blocks: string[]; blockedBy: string[] },
  ) => Promise<boolean>;
}) {
  const [blocks, setBlocks] = useState<string[]>(issue.relations.blocks);
  const [blockedBy, setBlockedBy] = useState<string[]>(issue.relations.blockedBy);
  const [saving, setSaving] = useState(false);
  const candidates = relationCandidates(issues, {
    excludeKey: issue.key,
    includeKeys: [...issue.relations.blocks, ...issue.relations.blockedBy],
  });

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    const ok = await onSave(issue.key, { blocks, blockedBy });
    setSaving(false);
    if (ok) {
      onClose();
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Edit relations"
      description="Pick every issue this one blocks and every issue blocking it. Only open issues are listed; existing relations stay listed even when Done."
      size="md"
    >
      <form
        data-testid="relation-dialog"
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-3.5"
      >
        {candidates.length === 0 ? (
          <p className="text-[11px] leading-snug text-fg-muted">
            No other open issues in this project.
          </p>
        ) : (
          <>
            <RelationSelect
              label="Blocked by"
              hint="These issues must reach Done before this one is claimable."
              candidates={candidates}
              value={blockedBy}
              onChange={setBlockedBy}
              testId="relation-blocked-by"
            />
            <RelationSelect
              label="Blocks"
              hint="This issue must reach Done before these issues are claimable."
              candidates={candidates}
              value={blocks}
              onChange={setBlocks}
              testId="relation-blocks"
            />
          </>
        )}
        <div className="mt-1 flex items-center justify-end gap-2 border-t border-line pt-3.5">
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={saving}
            data-testid="relation-save"
          >
            Save relations
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
