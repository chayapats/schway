import { XAI_REASONING_ITEM } from "./xai.ts";

/** Completed hosted web search item as xAI returns it, including a field Schway does not replay. */
export const XAI_WEB_SEARCH_ITEM = {
  id: "ws_fixture_1",
  type: "web_search_call",
  status: "completed",
  action: { type: "search", query: "bangkok weather today" },
  provider_debug: "dropped before storage",
};

/** The stored and replayed form of `XAI_WEB_SEARCH_ITEM`: only type, id, status and action. */
export const XAI_WEB_SEARCH_REPLAY_ITEM = {
  type: "web_search_call",
  id: "ws_fixture_1",
  status: "completed",
  action: { type: "search", query: "bangkok weather today" },
};

/** Build a reasoning, hosted search, message stream; `searches` sets how many completed search items arrive before the message. */
export function webSearchEvents(options: { searches?: readonly object[]; withSearch?: boolean; usage?: object } = {}): object[] {
  const searches = options.withSearch === false ? [] : options.searches ?? [XAI_WEB_SEARCH_ITEM];
  const events: object[] = [
    { type: "response.created", response: { id: "resp_search", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { id: "rs_xai", type: "reasoning", summary: [], encrypted_content: null } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Look at the repo." },
    { type: "response.output_item.done", output_index: 0, item: XAI_REASONING_ITEM },
  ];
  searches.forEach((item, offset) => {
    const index = 1 + offset;
    const id = (item as { id?: string }).id ?? `ws_${index}`;
    events.push(
      { type: "response.output_item.added", output_index: index, item: { id, type: "web_search_call", status: "in_progress" } },
      { type: "response.web_search_call.in_progress", output_index: index, item_id: id, sequence_number: 0 },
      { type: "response.web_search_call.searching", output_index: index, item_id: id, sequence_number: 1 },
      { type: "response.web_search_call.completed", output_index: index, item_id: id, sequence_number: 2 },
      { type: "response.output_item.done", output_index: index, item },
    );
  });
  const message = 1 + searches.length;
  events.push(
    { type: "response.output_item.added", output_index: message, item: { id: "msg_search", type: "message", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: message, delta: "Rain " },
    { type: "response.output_text.annotation.added", output_index: message, content_index: 0, annotation_index: 0, annotation: { type: "url_citation", url: "https://weather.example.test/", title: "Weather", start_index: 0, end_index: 4 } },
    { type: "response.output_text.delta", output_index: message, delta: "after 3 pm." },
    { type: "response.output_item.done", output_index: message, item: { id: "msg_search", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Rain after 3 pm.", annotations: [] }] } },
    { type: "response.completed", response: { id: "resp_search", status: "completed", usage: options.usage ?? { input_tokens: 40, output_tokens: 12 } } },
  );
  return events;
}
