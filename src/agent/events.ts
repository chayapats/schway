export type RuntimeEvent =
  | { type: "agent.started" }
  | { type: "agent.finished"; reason: "completed" | "error" }
  | { type: "model.started"; provider: string; model: string }
  | {
      type: "model.delta";
      content: { type: "text"; text: string } | { type: "thinking"; text: string };
    }
  | { type: "model.finished" }
  | { type: "error"; message: string };
