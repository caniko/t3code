import { PrincipalId, type SessionRole } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const isPrincipalId = Schema.is(PrincipalId);

const ROLE_LABELS = { viewer: "Viewer", participant: "Participant" } as const;

/** A person's sign-in name and the role to give them. */
export function PrincipalRoleForm(props: {
  readonly submitLabel: string;
  readonly disabled: boolean;
  readonly onSubmit: (principal: string, role: SessionRole) => Promise<boolean>;
}) {
  const [principal, setPrincipal] = useState("");
  const [role, setRole] = useState<SessionRole>("viewer");
  const [submitting, setSubmitting] = useState(false);
  const valid = isPrincipalId(principal);

  return (
    <form
      className="flex flex-wrap items-start gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!valid) return;
        setSubmitting(true);
        const done = await props.onSubmit(principal, role);
        setSubmitting(false);
        if (done) setPrincipal("");
      }}
    >
      <Input
        aria-label="Person"
        aria-invalid={principal !== "" && !valid}
        autoCapitalize="none"
        autoComplete="off"
        className="min-w-40 flex-1"
        nativeInput
        onChange={(event) => setPrincipal(event.currentTarget.value.trim())}
        placeholder="Sign-in name, such as dejana"
        spellCheck={false}
        value={principal}
      />
      <Select
        value={role}
        onValueChange={(value) => {
          if (value === "viewer" || value === "participant") setRole(value);
        }}
      >
        <SelectTrigger size="sm" className="w-36" aria-label="Role">
          <SelectValue>{ROLE_LABELS[role]}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          <SelectItem hideIndicator value="viewer">
            Viewer reads
          </SelectItem>
          <SelectItem hideIndicator value="participant">
            Participant sends too
          </SelectItem>
        </SelectPopup>
      </Select>
      <Button
        disabled={props.disabled || submitting || !valid}
        size="sm"
        type="submit"
        variant="outline"
      >
        {props.submitLabel}
      </Button>
    </form>
  );
}

export { ROLE_LABELS };
