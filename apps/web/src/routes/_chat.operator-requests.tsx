import { createFileRoute } from "@tanstack/react-router";

import { OperatorRequestsInbox } from "../components/OperatorRequestsInbox";

export const Route = createFileRoute("/_chat/operator-requests")({
  component: OperatorRequestsInbox,
});
